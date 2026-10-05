// The earlier meetings, read off the disk for the browser (GET /api/meetings, see http/routes/meetings.ts):
// the floor's `.agent-office/meetings/<id>/` folders, the full record each meeting left in its folder
// (`.meeting.json`) and the notes files in it. Only 8-hex-digit folders that are real folders directly
// under the root, and regular files directly in them, are ever read: a link out is never followed.
import { constants } from 'node:fs';
import { lstat, open, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { cleanRecord, isMeetingId, slimRecord } from '../shared/meetings.js';
import type { MeetingArchiveList, MeetingFileInfo, MeetingFileText, MeetingRecord } from '../shared/protocol.js';

/** The most meetings a list sends. */
const LIST_MAX = 500;
/** The biggest `.meeting.json` that is read. */
const RECORD_FILE_MAX = 64 * 1024;
/** The biggest notes file that is sent. */
export const MEETING_FILE_MAX = 1024 * 1024;

export interface Refusal {
  status: number;
  error: string;
}

const NO_FOLDER: Refusal = { status: 404, error: 'No such meeting' };
const NO_FILE: Refusal = { status: 404, error: 'No such file' };

/** Whether the archive's root is a real folder, not a link to somewhere else (deliberate defence in depth, with the realpath checks in folder()). */
const realRoot = (root: string): Promise<boolean> => lstat(root).then((st) => st.isDirectory() && !st.isSymbolicLink(), () => false);

/** The record a meeting left in its folder, or undefined when there is none or it isn't one (then the others are used). */
export async function folderRecord(root: string, id: string): Promise<MeetingRecord | undefined> {
  try {
    const file = path.join(root, id, '.meeting.json');
    const st = await lstat(file);
    if (!st.isFile() || st.size > RECORD_FILE_MAX) return undefined;
    const r = cleanRecord(JSON.parse(await readFile(file, 'utf8')));
    return r?.id === id ? r : undefined;
  } catch {
    return undefined;
  }
}

/** The longest piece of a meeting's question the list carries (the whole of it comes with the single record). */
const SNIPPET_MAX = 300;
/** How many folders' records are read at once. */
const READ_AT_ONCE = 16;

type Archived = MeetingRecord & { orphan?: boolean };

/** A list entry: the meeting's line and a short piece of its question. */
function entry(r: Archived): Archived {
  const prompt = typeof r.prompt === 'string' ? (r.prompt.length > SNIPPET_MAX ? `${r.prompt.slice(0, SNIPPET_MAX)}…` : r.prompt) : undefined;
  return { ...slimRecord(r), ...(prompt !== undefined ? { prompt } : {}), ...(r.orphan ? { orphan: true } : {}) };
}

/** A folder with no record and no state line: just its id and date. */
const orphanOf = (id: string, mtimeMs: number): Archived => ({ id, pattern: 'debate', title: `Meeting ${id}`, status: 'done', summary: '', calledBy: '', finishedAt: Math.round(mtimeMs), output: '', orphan: true });

/** Runs `fn` over `items`, `limit` at a time. */
async function inBatches<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  return out;
}

/** What a meeting's folder says about it: its record, else the state's line, else (a folder with neither) an orphan; undefined when it's no real folder. */
async function fromFolder(root: string, id: string, pastBy: Map<string, MeetingRecord>): Promise<Archived | undefined> {
  let st;
  try {
    st = await lstat(path.join(root, id));
  } catch {
    return undefined;
  }
  if (!st.isDirectory()) return undefined;
  return (await folderRecord(root, id)) ?? pastBy.get(id) ?? orphanOf(id, st.mtimeMs);
}

/**
 * Every earlier meeting: those still on a room's table (`finished`), then the ones with a record in their
 * folder, then the ones the state lists (`past`) and, for a folder with nothing else, just its id and date
 * (an orphan: it has the title "Meeting <id>", the debate pattern and no summary, which the list marks).
 * Newest first, at most 500, each as a line with a short piece of its question (the whole record is meetingRecordOf).
 */
export async function listMeetings(root: string, past: MeetingRecord[], finished: MeetingRecord[]): Promise<MeetingArchiveList> {
  const found = new Map<string, Archived>();
  for (const r of finished) found.set(r.id, r);
  let names: string[] = [];
  try {
    if (await realRoot(root)) names = await readdir(root);
  } catch {
    // no meetings yet
  }
  const pastBy = new Map(past.map((r) => [r.id, r]));
  const todo = names.filter((id) => isMeetingId(id) && !found.has(id));
  const read = await inBatches(todo, READ_AT_ONCE, (id) => fromFolder(root, id, pastBy));
  todo.forEach((id, i) => read[i] && found.set(id, read[i]!));
  for (const r of past) if (!found.has(r.id)) found.set(r.id, r);
  const all = [...found.values()].sort((a, b) => b.finishedAt - a.finishedAt);
  return { meetings: all.slice(0, LIST_MAX).map(entry), more: all.length > LIST_MAX };
}

/**
 * One meeting in full (GET /api/meetings/<id>), by the same priority as the list: on a table, in its folder's
 * record, in the state; a folder with nothing else is the orphan; no such meeting is a 404.
 */
export async function meetingRecordOf(root: string, id: string, past: MeetingRecord[], finished: MeetingRecord[]): Promise<Archived | Refusal> {
  if (!isMeetingId(id)) return NO_FOLDER;
  const table = finished.find((r) => r.id === id);
  if (table) return table;
  const pastBy = new Map(past.map((r) => [r.id, r]));
  const r = (await realRoot(root)) ? await fromFolder(root, id, pastBy) : undefined;
  return r ?? pastBy.get(id) ?? NO_FOLDER;
}

/** A meeting's folder: a real folder (not a link) directly under the root, or why not. The realpath checks are deliberate defence in depth on top of the lstat ones. */
async function folder(root: string, id: string): Promise<string | Refusal> {
  if (!isMeetingId(id)) return NO_FOLDER;
  try {
    if (!(await realRoot(root))) return NO_FOLDER;
    if (!(await lstat(path.join(root, id))).isDirectory()) return NO_FOLDER;
    const real = await realpath(path.join(root, id));
    return path.dirname(real) === (await realpath(root)) ? real : NO_FOLDER;
  } catch {
    return NO_FOLDER;
  }
}

/** The round a notes file belongs to: `r2-red.md` is round 2, and the plan is the first round's. */
const roundOf = (name: string): number | undefined => {
  const m = /^r(\d+)-/.exec(name);
  return name === 'plan.md' ? 1 : m ? Number(m[1]) : undefined;
};

/**
 * The files in a meeting's folder (its top level, no hidden files, no links): the output first, then the notes by round,
 * and how many entries were left out (folders, links, hard-linked or other files that aren't plain). With the meeting's
 * `output` path (from its record), only `output-<its name>` is the output: agents' notes are merged into the same folder.
 */
export async function listMeetingFiles(root: string, id: string, output?: string): Promise<{ files: MeetingFileInfo[]; skipped: number } | Refusal> {
  const dir = await folder(root, id);
  if (typeof dir !== 'string') return dir;
  const files: MeetingFileInfo[] = [];
  let skipped = 0;
  const outName = output ? `output-${path.basename(output)}` : undefined;
  try {
    for (const name of await readdir(dir)) {
      if (name.startsWith('.')) continue;
      const st = await lstat(path.join(dir, name)).catch(() => undefined);
      if (!st) continue; // gone since the listing
      if (!st.isFile() || st.nlink > 1) { // a hard link may lead to a file outside
        skipped++;
        continue;
      }
      const round = roundOf(name);
      const isOutput = outName !== undefined ? name === outName : name.startsWith('output-');
      files.push({ name, size: st.size, kind: isOutput ? 'output' : 'note', ...(round !== undefined ? { round } : {}) });
    }
  } catch {
    return NO_FOLDER;
  }
  const rank = (f: MeetingFileInfo) => (f.kind === 'output' ? 0 : 1);
  files.sort((a, b) => rank(a) - rank(b) || (a.round ?? Infinity) - (b.round ?? Infinity) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { files, skipped };
}

/** Opening without following a link at the end. Windows has no O_NOFOLLOW: there the lstat checks are all there is. */
// O_NONBLOCK: so a named pipe swapped in can't hold the open (it changes nothing for a regular file).
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** One notes file's text: a plain name in the meeting's folder, a regular file with one name, text, and no bigger than 1 MB. */
export async function readMeetingFile(root: string, id: string, name: string): Promise<MeetingFileText | Refusal> {
  const dir = await folder(root, id);
  if (typeof dir !== 'string') return dir;
  if (!name || /[/\\\0]/.test(name) || name.startsWith('.') || name !== path.basename(name)) return { status: 400, error: 'Bad file name' };
  const file = path.join(dir, name);
  let fh;
  try {
    // Opened once and checked on the handle, so nothing can be swapped in between the check and the read.
    if (!constants.O_NOFOLLOW && !(await lstat(file)).isFile()) return NO_FILE;
    fh = await open(file, OPEN_FLAGS);
    const st = await fh.stat();
    // nlink > 1: a hard link, which may be to a file outside the folder.
    if (!st.isFile() || st.nlink !== 1) return NO_FILE;
    if (st.size > MEETING_FILE_MAX) return { status: 413, error: 'That file is too big to show' };
    const buf = Buffer.alloc(Math.min(st.size, MEETING_FILE_MAX + 1));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const body = buf.subarray(0, bytesRead);
    if (body.subarray(0, 8192).includes(0)) return { status: 415, error: 'That file is not text' };
    return { name, size: st.size, text: body.toString('utf8') };
  } catch {
    return NO_FILE; // including ELOOP: a link
  } finally {
    await fh?.close();
  }
}

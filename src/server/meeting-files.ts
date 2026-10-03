// The earlier meetings, read off the disk for the browser (GET /api/meetings, see http/routes/meetings.ts):
// the floor's `.agent-office/meetings/<id>/` folders, the full record each meeting left in its folder
// (`.meeting.json`) and the notes files in it. Only 8-hex-digit folders that are real folders directly
// under the root, and regular files directly in them, are ever read: a link out is never followed.
import { constants } from 'node:fs';
import { lstat, open, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { cleanRecord, isMeetingId } from '../shared/meetings.js';
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

/** Whether the archive's root is a real folder, not a link to somewhere else. */
const realRoot = (root: string): Promise<boolean> => lstat(root).then((st) => st.isDirectory() && !st.isSymbolicLink(), () => false);

/** The record a meeting left in its folder, or undefined when there is none or it isn't one (then the others are used). */
async function folderRecord(root: string, id: string): Promise<MeetingRecord | undefined> {
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

/**
 * Every earlier meeting: those still on a room's table (`finished`), then the ones with a record in their
 * folder, then the ones the state lists (`past`) and, for a folder with nothing else, just its id and date
 * (an orphan: it has the title "Meeting <id>", the debate pattern and no summary, which the list marks).
 * Newest first, at most 500.
 */
export async function listMeetings(root: string, past: MeetingRecord[], finished: MeetingRecord[]): Promise<MeetingArchiveList> {
  const found = new Map<string, MeetingRecord & { orphan?: boolean }>();
  for (const r of finished) found.set(r.id, r);
  let names: string[] = [];
  try {
    if (await realRoot(root)) names = await readdir(root);
  } catch {
    // no meetings yet
  }
  const pastBy = new Map(past.map((r) => [r.id, r]));
  for (const id of names) {
    if (!isMeetingId(id)) continue;
    let st;
    try {
      st = await lstat(path.join(root, id));
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (found.has(id)) continue;
    const r = (await folderRecord(root, id)) ?? pastBy.get(id);
    found.set(id, r ?? { id, pattern: 'debate', title: `Meeting ${id}`, status: 'done', summary: '', calledBy: '', finishedAt: Math.round(st.mtimeMs), output: '', orphan: true });
  }
  for (const r of past) if (!found.has(r.id)) found.set(r.id, r);
  const all = [...found.values()].sort((a, b) => b.finishedAt - a.finishedAt);
  return { meetings: all.slice(0, LIST_MAX), more: all.length > LIST_MAX };
}

/** A meeting's folder: a real folder (not a link) directly under the root, or why not. */
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
const roundOf = (name: string): number | undefined => (name === 'plan.md' ? 1 : /^r(\d+)-/.exec(name)?.[1] ? Number(/^r(\d+)-/.exec(name)![1]) : undefined);

/** The files in a meeting's folder (its top level, no hidden files, no links): the output first, then the notes by round. */
export async function listMeetingFiles(root: string, id: string): Promise<{ files: MeetingFileInfo[] } | Refusal> {
  const dir = await folder(root, id);
  if (typeof dir !== 'string') return dir;
  const files: MeetingFileInfo[] = [];
  try {
    for (const name of await readdir(dir)) {
      if (name.startsWith('.')) continue;
      const st = await lstat(path.join(dir, name)).catch(() => undefined);
      if (!st?.isFile() || st.nlink > 1) continue; // a hard link may lead to a file outside
      const round = roundOf(name);
      files.push({ name, size: st.size, kind: name.startsWith('output-') ? 'output' : 'note', ...(round !== undefined ? { round } : {}) });
    }
  } catch {
    return NO_FOLDER;
  }
  const rank = (f: MeetingFileInfo) => (f.kind === 'output' ? 0 : 1);
  files.sort((a, b) => rank(a) - rank(b) || (a.round ?? Infinity) - (b.round ?? Infinity) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { files };
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

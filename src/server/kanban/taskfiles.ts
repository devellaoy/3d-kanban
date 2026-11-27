// A task's files in its grant folder that prompts name by path: the accepted plan, the conversation and the UI test's report.

import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, rmSync, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { failOnce, putOfficeFile, replaceOfficeFile } from './officefile.js';
import { grantDir } from './uploads.js';

export function planFilePath(filesDir: string, taskId: number): string {
  return path.join(grantDir(filesDir, taskId), 'accepted-plan.md');
}

export function conversationFilePath(filesDir: string, taskId: number): string {
  return path.join(grantDir(filesDir, taskId), 'conversation.md');
}

/** Never throws. The path only when the file holds the current text; no text removes the file; a failed write removes a stale file and returns undefined. */
function sync(file: string, what: string, text: string | undefined): string | undefined {
  const drop = () => {
    try {
      rmSync(file, { force: true });
    } catch {
      // it stays; nothing more to try
    }
  };
  if (!text?.trim()) {
    drop();
    return undefined;
  }
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (putOfficeFile(file, text)) return file;
  } catch (err) {
    failOnce(`write ${file} (${what})`, err);
  }
  // An older text would be read as the current one.
  drop();
  return undefined;
}

export function syncPlanFile(filesDir: string, taskId: number, text: string | undefined): string | undefined {
  return sync(planFilePath(filesDir, taskId), 'the accepted plan', text);
}

export function syncConversationFile(filesDir: string, taskId: number, markdown: string | undefined): string | undefined {
  return sync(conversationFilePath(filesDir, taskId), 'the conversation', markdown);
}

/** The report the UI tester of a pull-request review writes (the tester itself creates it; the office only resets, reads and normalises it). */
export function uiTestReportPath(filesDir: string, taskId: number): string {
  return path.join(grantDir(filesDir, taskId), 'ui-test-report.md');
}

/** A report file's name in the grant folder: the report's own, or the one a report is kept under when that path cannot be written. */
const REPORT_NAME = /^ui-test-report(\.[0-9a-f]{16})?\.md$/;

/**
 * Keeps `text` as the report, replacing whatever is at its path without reading it (the tester may have left a file of any size,
 * a link or a folder there): written whole and renamed over it; a folder, which a rename cannot replace, is removed first. When
 * that path can be neither replaced nor cleared, the whole report is kept beside it under a name of its own (ui-test-report.<random>.md),
 * so it is never lost or cut. Returns the path of the file that holds the text; undefined for blank text, or when no file could be written. Never throws.
 */
export function storeUiTestReport(filesDir: string, taskId: number, text: string | undefined): string | undefined {
  const file = uiTestReportPath(filesDir, taskId);
  const body = text?.trim() ? `${text.trim()}\n` : '';
  if (!body) {
    dropUiTestReport(filesDir, taskId);
    return undefined;
  }
  const spare = path.join(path.dirname(file), `ui-test-report.${randomBytes(8).toString('hex')}.md`);
  for (const [to, clear] of [[file, false], [file, true], [spare, false]] as const) {
    try {
      mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
      if (clear) rmSync(to, { force: true, recursive: true });
      replaceOfficeFile(to, body);
      return to;
    } catch (err) {
      if (clear || to === spare) failOnce(`write ${to} (the UI test report)`, err);
    }
  }
  return undefined;
}

/**
 * Leaves nothing at the report's path, whatever is there (a file, a read-only copy, a link, a folder), nor a report kept under
 * another name, so the next report can be written. A link is removed, never followed. Never throws; returns whether the report's path is clear.
 */
export function dropUiTestReport(filesDir: string, taskId: number): boolean {
  const file = uiTestReportPath(filesDir, taskId);
  let names: string[] = [];
  try {
    names = readdirSync(path.dirname(file)).filter((n) => REPORT_NAME.test(n));
  } catch {
    // no grant folder yet: nothing to remove
  }
  for (const n of names) {
    const at = path.join(path.dirname(file), n);
    try {
      rmSync(at, { force: true, recursive: true });
    } catch (err) {
      // It stays: a prompt names a report file only when it holds the text the office stored (uiTestReportFor), and what is left
      // at the report's own path is never taken for the next test's report (resetUiTestReport).
      failOnce(`remove ${at} (the UI test report)`, err);
    }
  }
  try {
    lstatSync(file);
    return false;
  } catch {
    return true;
  }
}

/** The bytes a report file holds for `text`, as storeUiTestReport writes it. */
export const uiTestReportBytes = (text: string): number => Buffer.byteLength(`${text.trim()}\n`, 'utf8');

const REPORT_MAX_BYTES = 200_000;

/** How readUiTestReport reads: the size limit, and what a test may put in its way (a step before the open and after it, and the platform's no-follow flag; 0: none). */
export interface ReportReadSteps {
  beforeOpen?: () => void;
  opened?: () => void;
  noFollow?: number;
  /**
   * The most bytes the file may have: the tester's own file is held to REPORT_MAX_BYTES (the default); a file the office stored
   * itself is read against the size it was given, which it knows.
   */
  maxBytes?: number;
}

/**
 * The tester's report: only a regular file (never a link) up to 200 kB with text in it; anything else, or any error, is no report
 * (the caller then goes by the tester's reply). The file is opened without following a link where the platform can say so, and
 * everywhere the open file must be the very file the path names, itself no link, before and after the open (device and inode):
 * a path changed into a link in between is refused. It is checked and read through that one descriptor, at most the limit's
 * bytes. Never throws.
 */
export function readUiTestReport(filesDir: string, taskId: number, steps: ReportReadSteps = {}, name?: string): string | undefined {
  let fd: number | undefined;
  try {
    // `name`: a report kept under another name in the same folder (storeUiTestReport); nothing else is ever read.
    if (name !== undefined && !REPORT_NAME.test(name)) return undefined;
    const file = name === undefined ? uiTestReportPath(filesDir, taskId) : path.join(path.dirname(uiTestReportPath(filesDir, taskId)), name);
    const same = (a: BigIntStats, b: BigIntStats) => a.isFile() && b.isFile() && a.ino !== 0n && a.ino === b.ino && a.dev === b.dev;
    const before = lstatSync(file, { bigint: true });
    if (!before.isFile()) return undefined;
    steps.beforeOpen?.();
    // Never a blocking open of a pipe.
    fd = openSync(file, constants.O_RDONLY | (steps.noFollow ?? constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    steps.opened?.();
    const st = fstatSync(fd, { bigint: true });
    const max = steps.maxBytes ?? REPORT_MAX_BYTES;
    if (!same(before, st) || st.size > BigInt(max)) return undefined;
    const buf = Buffer.alloc(max + 1);
    let n = 0;
    for (let got = -1; got !== 0 && n < buf.length; n += got) got = readSync(fd, buf, n, buf.length - n, null);
    // It grew while it was read: not the report that was checked.
    if (n > max) return undefined;
    return buf.toString('utf8', 0, n).trim() || undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

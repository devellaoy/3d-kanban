// A task's files in its grant folder that prompts name by path: the accepted plan, the conversation and the UI test's report.

import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, rmSync, type BigIntStats } from 'node:fs';
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

/**
 * Keeps `text` as the report, replacing whatever is at its path without reading it (the tester may have left a file of any size,
 * a link or a folder there): written whole and renamed over it; a folder, which a rename cannot replace, is removed first. Blank
 * text, or a write that fails, leaves nothing at the path: an older or a foreign file would be read as the report. Returns the path when it holds the text. Never throws.
 */
export function storeUiTestReport(filesDir: string, taskId: number, text: string | undefined): string | undefined {
  const file = uiTestReportPath(filesDir, taskId);
  const body = text?.trim() ? `${text.trim()}\n` : '';
  if (body) {
    for (const again of [false, true]) {
      try {
        mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        if (again) rmSync(file, { force: true, recursive: true });
        replaceOfficeFile(file, body);
        return file;
      } catch (err) {
        if (again) failOnce(`write ${file} (the UI test report)`, err);
      }
    }
  }
  dropUiTestReport(filesDir, taskId);
  return undefined;
}

/** Leaves nothing at the report's path, whatever is there (a file, a read-only copy, a link, a folder), so the next report can be written. A link is removed, never followed. Never throws. */
export function dropUiTestReport(filesDir: string, taskId: number): void {
  const file = uiTestReportPath(filesDir, taskId);
  try {
    rmSync(file, { force: true, recursive: true });
  } catch (err) {
    // It stays: hasUiTestReport and readUiTestReport still take nothing but a regular file of the allowed size there.
    failOnce(`remove ${file} (the UI test report)`, err);
  }
}

const REPORT_MAX_BYTES = 200_000;

/** Whether a report is there for a prompt to name: a regular file only (not a link, not a folder). Never throws. */
export function hasUiTestReport(filesDir: string, taskId: number): boolean {
  try {
    return lstatSync(uiTestReportPath(filesDir, taskId)).isFile();
  } catch {
    return false;
  }
}

/** What a test may put in the way of readUiTestReport: a step before the open and after it, and the platform's no-follow flag (0: none). */
export interface ReportReadSteps {
  beforeOpen?: () => void;
  opened?: () => void;
  noFollow?: number;
}

/**
 * The tester's report: only a regular file (never a link) up to 200 kB with text in it; anything else, or any error, is no report
 * (the caller then goes by the tester's reply). The file is opened without following a link where the platform can say so, and
 * everywhere the open file must be the very file the path names, itself no link, before and after the open (device and inode):
 * a path changed into a link in between is refused. It is checked and read through that one descriptor, at most the limit's
 * bytes. Never throws.
 */
export function readUiTestReport(filesDir: string, taskId: number, steps: ReportReadSteps = {}): string | undefined {
  let fd: number | undefined;
  try {
    const file = uiTestReportPath(filesDir, taskId);
    const same = (a: BigIntStats, b: BigIntStats) => a.isFile() && b.isFile() && a.ino !== 0n && a.ino === b.ino && a.dev === b.dev;
    const before = lstatSync(file, { bigint: true });
    if (!before.isFile()) return undefined;
    steps.beforeOpen?.();
    // Never a blocking open of a pipe.
    fd = openSync(file, constants.O_RDONLY | (steps.noFollow ?? constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    steps.opened?.();
    const st = fstatSync(fd, { bigint: true });
    if (!same(before, st) || st.size > BigInt(REPORT_MAX_BYTES)) return undefined;
    const buf = Buffer.alloc(REPORT_MAX_BYTES + 1);
    let n = 0;
    for (let got = -1; got !== 0 && n < buf.length; n += got) got = readSync(fd, buf, n, buf.length - n, null);
    // It grew while it was read: not the report that was checked.
    if (n > REPORT_MAX_BYTES) return undefined;
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

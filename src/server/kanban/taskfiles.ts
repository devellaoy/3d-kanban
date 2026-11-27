// A task's files in its grant folder that prompts name by path: the accepted plan, the conversation and the UI test's report.

import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, rmSync } from 'node:fs';
import path from 'node:path';
import { failOnce, putOfficeFile } from './officefile.js';
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

export function syncUiTestReport(filesDir: string, taskId: number, text: string | undefined): string | undefined {
  return sync(uiTestReportPath(filesDir, taskId), 'the UI test report', text);
}

/** Leaves nothing at the report's path, whatever is there (a file, a read-only copy, a link, a folder), so the next report can be written. A link is removed, never followed. Never throws. */
export function dropUiTestReport(filesDir: string, taskId: number): void {
  try {
    rmSync(uiTestReportPath(filesDir, taskId), { force: true, recursive: true });
  } catch {
    // it stays; nothing more to try
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

/**
 * The tester's report: only a regular file (never a link) up to 200 kB with text in it; anything else, or any error, is no report.
 * The file is opened without following a link and checked and read through that one descriptor, at most the limit's bytes, so
 * what is at the path cannot change between the check and the read. `opened` is for tests: called once the file is open. Never throws.
 */
export function readUiTestReport(filesDir: string, taskId: number, opened?: () => void): string | undefined {
  let fd: number | undefined;
  try {
    const file = uiTestReportPath(filesDir, taskId);
    // Not a link (checked again by O_NOFOLLOW where the platform has it), and never a blocking open of a pipe.
    if (!lstatSync(file).isFile()) return undefined;
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    opened?.();
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > REPORT_MAX_BYTES) return undefined;
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

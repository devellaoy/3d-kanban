// A task's files in its grant folder that prompts name by path: the accepted plan, the conversation and the UI test's report.

import { lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
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

/** Leaves no report at all, whatever is at its path (a file, a read-only copy, a link), so the next tester can create it. Never throws. */
export function dropUiTestReport(filesDir: string, taskId: number): void {
  try {
    rmSync(uiTestReportPath(filesDir, taskId), { force: true });
  } catch {
    // it stays; nothing more to try
  }
}

const REPORT_MAX_BYTES = 200_000;

/** The tester's report: only a regular file (never a link) up to 200 kB with text in it; anything else, or any error, is no report. Never throws. */
export function readUiTestReport(filesDir: string, taskId: number): string | undefined {
  try {
    const file = uiTestReportPath(filesDir, taskId);
    const st = lstatSync(file);
    if (!st.isFile() || st.size > REPORT_MAX_BYTES) return undefined;
    return readFileSync(file, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

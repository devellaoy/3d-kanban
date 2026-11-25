// A task's files in its grant folder that prompts name by path: the accepted plan and the conversation.

import { mkdirSync, rmSync } from 'node:fs';
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

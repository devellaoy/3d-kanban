// Files the office writes for the agents to read: read-only, replaced whole, never half-written.

import { chmodSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

/** Each failure is logged once: the files are synced often, and a folder that can't be written stays that way. */
const logged = new Set<string>();
export const failOnce = (what: string, err: unknown) => {
  const line = `agent-office: couldn't ${what}: ${(err as Error).message}`;
  if (logged.has(line)) return;
  logged.add(line);
  console.error(line);
};

/** Writes `text` to `file` unless it is there already; blank text removes the file. Returns whether the file now holds the text. */
export function putOfficeFile(file: string, text: string | undefined): boolean {
  const body = text?.trim() ? `${text.trim()}\n` : '';
  if (!body) {
    rmSync(file, { force: true });
    return false;
  }
  try {
    // A plain file of ours only: a link with the same text is replaced, as what it points at may change later.
    if (lstatSync(file).isFile() && readFileSync(file, 'utf8') === body) return true;
  } catch {
    // missing or unreadable: written below
  }
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, body, { mode: 0o444 });
    // Windows refuses to rename over a read-only file: there the old one is made writable first (it is replaced whole either way).
    // Only a plain file of ours, never through a link: chmod would change what the link points at.
    if (process.platform === 'win32') {
      try {
        if (lstatSync(file).isFile()) chmodSync(file, 0o644);
      } catch {
        // not there yet
      }
    }
    renameSync(tmp, file);
    chmodSync(file, 0o444);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return true;
}

// Files the office writes for the agents to read: read-only, replaced whole, never half-written.

import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, fchmodSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';

/** Each failure is logged once: the files are synced often, and a folder that can't be written stays that way. */
const logged = new Set<string>();
export const failOnce = (what: string, err: unknown) => {
  const line = `agent-office: couldn't ${what}: ${(err as Error).message}`;
  if (logged.has(line)) return;
  logged.add(line);
  console.error(line);
};

/** A name for the temporary file beside `file`: not one another process can know beforehand. */
const tmpName = (file: string) => `${file}.${randomBytes(8).toString('hex')}.tmp`;

/**
 * Puts `body` in `file` whole, without reading what is there: a new temporary file beside it (created exclusively, so a file or a
 * link already at that name is never written through; another name is tried then), renamed over `file`. A link at `file` is
 * replaced, not followed. Throws when it cannot be written (a folder at `file`, say). `tmp` is for tests.
 */
export function replaceOfficeFile(file: string, body: string, tmp: (file: string) => string = tmpName): void {
  let made: string | undefined;
  try {
    for (let i = 0; made === undefined; i++) {
      const name = tmp(file);
      try {
        const fd = openSync(name, 'wx', 0o444);
        made = name;
        try {
          // To the last byte: one write may take only a part of it.
          const bytes = Buffer.from(body, 'utf8');
          for (let at = 0; at < bytes.length; ) {
            const n = writeSync(fd, bytes, at, bytes.length - at);
            if (n <= 0) throw new Error(`only ${at} of ${bytes.length} bytes could be written`);
            at += n;
          }
          fchmodSync(fd, 0o444);
        } finally {
          closeSync(fd);
        }
      } catch (err) {
        if (made !== undefined || (err as NodeJS.ErrnoException).code !== 'EEXIST' || i >= 4) throw err;
      }
    }
    // Windows refuses to rename over a read-only file: there the old one is made writable first (it is replaced whole either way).
    // Only a plain file of ours, never through a link: chmod would change what the link points at.
    if (process.platform === 'win32') {
      try {
        if (lstatSync(file).isFile()) chmodSync(file, 0o644);
      } catch {
        // not there yet
      }
    }
    renameSync(made, file);
  } catch (err) {
    if (made !== undefined) rmSync(made, { force: true });
    throw err;
  }
}

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
  replaceOfficeFile(file, body);
  return true;
}

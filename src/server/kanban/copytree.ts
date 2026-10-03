// A stand-in for fs.cpSync. Node 22's cpSync is native (std::filesystem), and on Windows a path with a
// non-ASCII character (C:\Ylimäki Media\…) kills the whole process with 0xC0000409, past any try/catch.
// This walks the tree with readdirSync/copyFileSync, which take such paths fine.

import { copyFileSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync } from 'node:fs';
import path from 'node:path';

/**
 * Copies a file, or a folder and everything in it, to `to`, like `cpSync(from, to, { recursive: true, filter })`:
 * folders are merged into what's there, files overwritten, symlinks copied as links. `filter` is asked about
 * every source path, `from` included; a folder it refuses is skipped whole. A link already at the destination
 * is never followed, as cpSync doesn't: a folder over one is refused, a file or link replaces it.
 */
export function copyTree(from: string, to: string, filter?: (src: string) => boolean): void {
  if (filter && !filter(from)) return;
  const st = lstatSync(from);
  const linkAtDest = lstatSync(to, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
  if (st.isDirectory()) {
    if (linkAtDest) throw new Error(`cannot copy the folder ${from} over the link ${to}`);
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) copyTree(path.join(from, name), path.join(to, name), filter);
  } else if (st.isSymbolicLink()) {
    const link = readlinkSync(from);
    const target = path.isAbsolute(link) ? link : path.resolve(path.dirname(from), link);
    rmSync(to, { force: true });
    mkdirSync(path.dirname(to), { recursive: true });
    symlinkSync(target, to, isFolder(target) ? 'junction' : 'file');
  } else {
    if (linkAtDest) rmSync(to);
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
}

function isFolder(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

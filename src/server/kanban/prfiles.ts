// A PR over GitHub's 300-file limit has no `.diff`; its diff is built here from the files API.

/** What gh says when GitHub won't send a PR's diff because it is too big. */
export const DIFF_TOO_LARGE = /too_large|exceeded the maximum number of (files|lines)|HTTP 406/i;

/** One entry of `GET /repos/:owner/:repo/pulls/:n/files` (the fields we read). */
export interface GhPrFile {
  filename: string;
  status: string;
  previous_filename?: string | null;
  /** Missing when the file is binary or too big for GitHub to send. */
  patch?: string | null;
  additions?: number;
  deletions?: number;
}

/** A path as git writes it in a diff header: C-quoted when it has a quote, backslash or control character, so a file name can't start a header line of its own. */
function gitPath(prefix: string, p: string): string {
  if (!/["\\\x00-\x1f\x7f]/.test(p)) return prefix + p;
  const esc: Record<string, string> = { '"': '\\"', '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r' };
  return `"${(prefix + p).replace(/["\\\x00-\x1f\x7f]/g, (c) => esc[c] ?? `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`)}"`;
}

/** The files as a unified diff `parseDiff` (client/ui/pulldiff.ts) reads like `gh pr diff`'s. */
export function diffFromFiles(files: GhPrFile[]): string {
  let out = '';
  for (const f of files) {
    const oldPath = f.previous_filename || f.filename;
    const [a, b] = [gitPath('a/', oldPath), gitPath('b/', f.filename)];
    const patch = f.patch ?? '';
    const renamed = f.status === 'renamed';
    out += `diff --git ${a} ${b}\n`;
    if (f.status === 'added') out += `new file mode 100644\n--- /dev/null\n+++ ${b}\n`;
    else if (f.status === 'removed') out += `deleted file mode 100644\n--- ${a}\n+++ /dev/null\n`;
    else {
      if (renamed) out += `rename from ${gitPath('', oldPath)}\nrename to ${gitPath('', f.filename)}\n`;
      if (!renamed || patch) out += `--- ${a}\n+++ ${b}\n`;
    }
    if (patch) out += patch.endsWith('\n') ? patch : `${patch}\n`;
    // No patch and no changed lines: a binary file (or a pure rename, which needs nothing more).
    else if (!f.additions && !f.deletions) out += renamed ? '' : `Binary files ${a} and ${b} differ\n`;
    else out += `\\ Too large to show here (+${f.additions ?? 0} −${f.deletions ?? 0}) — open the file on GitHub.\n`;
  }
  return out;
}

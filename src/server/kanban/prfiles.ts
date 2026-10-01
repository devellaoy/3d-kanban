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

/** The files as a unified diff `parseDiff` (client/ui/pulldiff.ts) reads like `gh pr diff`'s. */
export function diffFromFiles(files: GhPrFile[]): string {
  let out = '';
  for (const f of files) {
    const oldPath = f.previous_filename || f.filename;
    const patch = f.patch ?? '';
    const renamed = f.status === 'renamed';
    out += `diff --git a/${oldPath} b/${f.filename}\n`;
    if (f.status === 'added') out += `new file mode 100644\n--- /dev/null\n+++ b/${f.filename}\n`;
    else if (f.status === 'removed') out += `deleted file mode 100644\n--- a/${oldPath}\n+++ /dev/null\n`;
    else {
      if (renamed) out += `rename from ${oldPath}\nrename to ${f.filename}\n`;
      if (!renamed || patch) out += `--- a/${oldPath}\n+++ b/${f.filename}\n`;
    }
    if (patch) out += patch.endsWith('\n') ? patch : `${patch}\n`;
    // No patch and no changed lines: a binary file (or a pure rename, which needs nothing more).
    else if (!f.additions && !f.deletions) out += renamed ? '' : `Binary files a/${oldPath} and b/${f.filename} differ\n`;
    else out += `\\ Too large to show here (+${f.additions ?? 0} −${f.deletions ?? 0}) — open the file on GitHub.\n`;
  }
  return out;
}

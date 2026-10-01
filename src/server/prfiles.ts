// A PR over GitHub's 300-file limit has no `.diff`; its diff is built here from the files API.
import { repoApi } from './ghrepo.js';

/** What gh says when GitHub won't send a PR's diff because it is too big. */
export const DIFF_TOO_LARGE = /PullRequest\.diff too_large|diff exceeded the maximum number of (files|lines)/i;

/** gh from server/github.ts (passed in rather than imported, which would be circular). */
export type GhRun = (args: string[], cwd: string, timeout?: number) => Promise<string>;

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

/** The files as a unified diff `parseDiff` (client/ui/pulldiff.ts) reads like `gh pr diff`'s. `total` is the PR's file count, when GitHub lists fewer. */
export function diffFromFiles(files: GhPrFile[], total?: number): string {
  let out = '';
  for (const f of files) {
    const oldPath = f.previous_filename || f.filename;
    const [a, b] = [gitPath('a/', oldPath), gitPath('b/', f.filename)];
    const patch = f.patch ?? '';
    const renamed = f.status === 'renamed';
    const copied = f.status === 'copied';
    out += `diff --git ${a} ${b}\n`;
    if (f.status === 'added' || copied) {
      out += `new file mode 100644\n--- /dev/null\n+++ ${b}\n`;
      if (copied) out += `\\ Copied from ${gitPath('', oldPath).replace(/^"|"$/g, '')}\n`;
    } else if (f.status === 'removed') out += `deleted file mode 100644\n--- ${a}\n+++ /dev/null\n`;
    else {
      if (renamed) out += `rename from ${gitPath('', oldPath)}\nrename to ${gitPath('', f.filename)}\n`;
      if (!renamed || patch) out += `--- ${a}\n+++ ${b}\n`;
    }
    if (patch) out += patch.endsWith('\n') ? patch : `${patch}\n`;
    // No patch and no changed lines: a pure rename needs nothing more; otherwise it may be binary, empty or mode-only, which the API doesn't say.
    else if (!f.additions && !f.deletions) out += renamed ? '' : '\\ No text changes to show (binary, empty or mode-only) — open the file on GitHub.\n';
    else out += `\\ Too large to show here (+${f.additions ?? 0} −${f.deletions ?? 0}) — open the file on GitHub.\n`;
  }
  if (total !== undefined && total > files.length) {
    const rest = `⋯ ${total - files.length} more files not listed by GitHub`;
    out += `diff --git a/${rest} b/${rest}\nnew file mode 100644\n--- /dev/null\n+++ b/${rest}\n`;
    out += `\\ GitHub lists only the first ${files.length} of ${total} files — open the pull request on GitHub for the rest.\n`;
  }
  return out;
}

const MAX_CACHED = 8;
/** PRs whose `.diff` GitHub refused, so the next ask skips straight to the files API. */
const tooLarge = new Set<string>();
/** The diff built last for a PR, valid while its head commit is the same. */
const built = new Map<string, { sha: string; text: string }>();
const building = new Map<string, Promise<string>>();

/** Forgets what was learned about PRs (for tests). */
export function resetPrFilesCache(): void {
  tooLarge.clear();
  built.clear();
  building.clear();
}

/** `diff()` (gh pr diff), or for a PR over GitHub's diff limit the diff built from the files API (kept per head commit). */
export async function pullDiffOrFiles(run: GhRun, target: string | undefined, n: number, dir: string, diff: () => Promise<string>): Promise<string> {
  const key = `${target ?? dir}#${n}`;
  if (!tooLarge.has(key)) {
    try {
      return await diff();
    } catch (err) {
      if (!DIFF_TOO_LARGE.test((err as Error).message)) throw err;
      tooLarge.add(key);
    }
  }
  const meta = JSON.parse(await run(['api', repoApi(target, `pulls/${n}`), '--jq', '{sha: .head.sha, files: .changed_files}'], dir)) as { sha: string; files: number };
  const hit = built.get(key);
  if (hit && hit.sha === meta.sha) return hit.text;
  const flight = `${key}@${meta.sha}`;
  let p = building.get(flight);
  if (!p) {
    p = (async () => {
      try {
        const jq = '.[] | {filename, status, previous_filename, patch, additions, deletions}';
        const out = await run(['api', repoApi(target, `pulls/${n}/files?per_page=100`), '--paginate', '--jq', jq], dir, 120_000);
        const text = diffFromFiles(out.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as GhPrFile), meta.files);
        built.delete(key);
        built.set(key, { sha: meta.sha, text });
        while (built.size > MAX_CACHED) built.delete(built.keys().next().value as string);
        return text;
      } catch (err) {
        if (/maxBuffer/i.test((err as Error).message)) throw new Error("This pull request's diff is too big to show here — open it on GitHub.");
        throw err;
      } finally {
        building.delete(flight);
      }
    })();
    building.set(flight, p);
  }
  return p;
}

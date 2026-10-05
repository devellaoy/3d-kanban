// A pull request's diff on Azure DevOps, which has no diff to give: its latest iteration's changed
// files against the merge base, each file's two blobs read from the API and diffed here (unidiff.ts).
// Read-only: nothing is fetched into anybody's checkout.

import type { RepoRef } from '../../shared/hosting/remote.js';
import { gitPath } from '../gitpath.js';
import { azureRepoApi } from './azure.js';
import { hostCall, hostText } from './http.js';
import type { Fetch, HostAs } from './provider.js';
import { unifiedHunks } from './unidiff.js';

/** The most files a diff shows (the rest are named), and the biggest file it diffs. */
export const DIFF_FILES = 300;
const FILE_MAX = 1024 * 1024;

const blob = (repo: RepoRef, id: string, as: HostAs, fetch: Fetch) => hostText(fetch, as, azureRepoApi(repo, `/blobs/${encodeURIComponent(id)}?$format=octetstream`), 'application/octet-stream');

/** Unified diff of pull request `n`, as `git diff <merge base> <head>` would print it. */
export async function azureDiff(repo: RepoRef, n: number, as: HostAs, fetch: Fetch): Promise<string> {
  const its = ((await hostCall(fetch, as, 'GET', azureRepoApi(repo, `/pullrequests/${n}/iterations`)))?.value ?? []) as any[];
  const last = its.reduce<number>((m, it) => Math.max(m, Number(it?.id) || 0), 0);
  if (!last) return '';
  const entries = (((await hostCall(fetch, as, 'GET', azureRepoApi(repo, `/pullrequests/${n}/iterations/${last}/changes?$top=2000&$compareTo=0`)))?.changeEntries ?? []) as any[]).filter(
    (e) => e?.item?.path && !e.item.isFolder && (e.item.gitObjectType ?? 'blob') === 'blob',
  );
  let out = '';
  for (const e of entries.slice(0, DIFF_FILES)) out += await fileDiff(repo, e, as, fetch);
  if (entries.length > DIFF_FILES) out += `\\ ${entries.length - DIFF_FILES} more files changed: see the pull request on Azure DevOps\n`;
  return out;
}

async function fileDiff(repo: RepoRef, e: any, as: HostAs, fetch: Fetch): Promise<string> {
  const type = String(e.changeType ?? '').toLowerCase();
  const path = String(e.item.path).replace(/^\//, '');
  const oldPath = String(e.originalPath ?? e.sourceServerItem ?? e.item.originalPath ?? e.item.path).replace(/^\//, '');
  const added = type.includes('add');
  const deleted = type.includes('delete');
  const renamed = type.includes('rename') && oldPath !== path;
  const [a, b] = [gitPath('a/', renamed ? oldPath : path), gitPath('b/', path)];
  let head = `diff --git ${a} ${b}\n`;
  if (added) head += 'new file mode 100644\n';
  if (deleted) head += 'deleted file mode 100644\n';
  if (renamed) head += `rename from ${gitPath('', oldPath)}\nrename to ${gitPath('', path)}\n`;
  const [before, after] = await Promise.all([
    added || !e.item.originalObjectId ? '' : blob(repo, e.item.originalObjectId, as, fetch),
    deleted || !e.item.objectId ? '' : blob(repo, e.item.objectId, as, fetch),
  ]);
  const from = added ? '/dev/null' : a;
  const to = deleted ? '/dev/null' : b;
  if (before.includes('\0') || after.includes('\0')) return `${head}Binary files ${from} and ${to} differ\n`;
  if (before.length > FILE_MAX || after.length > FILE_MAX) return `${head}\\ Too big to show here: see the pull request on Azure DevOps\n`;
  const hunks = unifiedHunks(before, after);
  return hunks ? `${head}--- ${from}\n+++ ${to}\n${hunks}` : head;
}

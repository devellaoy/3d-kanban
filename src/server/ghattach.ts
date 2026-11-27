// A pull request's conversation comment with pictures attached (`gh pr comment --body-file … --attach …`): what the kanban's posted
// review uses when its findings show in UI-test pictures (a review itself cannot carry attachments). gh uploads the files and rewrites
// the body's `./name` references. It may also post the comment and still fail (some uploads failed), or fail before posting anything,
// so a failure is looked into before anyone posts again: the two errors below say which it was, any other error means nobody knows.

import { readFile } from 'node:fs/promises';

type Run = (args: string[], cwd: string, timeout?: number, env?: Record<string, string>) => Promise<string>;

/** gh failed and the comment is certainly not there: posting again makes no duplicate. */
export class PicturesNotPosted extends Error {}

/** gh failed, but the comment is there (with the pictures that did upload): `url` is its address. */
export class PicturesPartly extends Error {
  constructor(message: string, readonly url: string) {
    super(message);
  }
}

/** The picture references that close a body (postreview.ts): what comes before them is what the posted comment starts with. */
const BLOCK = /(?:\n+!\[[^\]\n]*\]\([^)\n]*\))+\s*$/;
const flat = (s: string) => s.replace(/\r\n?/g, '\n').trim();

/** Posts the comment and resolves to its URL. Rejects with PicturesNotPosted, PicturesPartly, or (the outcome unknown) gh's own error. */
export async function commentWithPictures(run: Run, repo: string, n: number, file: string, attach: readonly string[], cwd: string, env?: Record<string, string>): Promise<string> {
  // A little before now: the office's clock and GitHub's need not agree, and the text decides which comment is ours.
  const since = new Date(Date.now() - 120_000).toISOString();
  try {
    const out = await run(['pr', 'comment', String(n), '--repo', repo, '--body-file', file, ...attach.flatMap((f) => ['--attach', f])], cwd, Math.min(600_000, 60_000 + attach.length * 10_000), env);
    return out.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
  } catch (err) {
    const why = (err as Error).message;
    // gh says so itself when every upload failed before the comment was made.
    if (/no comment was posted/i.test(why)) throw new PicturesNotPosted(why);
    let made: { html_url?: unknown; body?: unknown }[];
    try {
      const text = flat((await readFile(file, 'utf8')).replace(BLOCK, ''));
      const raw = await run(['api', `repos/${repo}/issues/${n}/comments?since=${since}&per_page=100`], cwd, 30_000, env);
      made = (JSON.parse(raw) as typeof made).filter((c) => typeof c.body === 'string' && flat(c.body).startsWith(text));
    } catch {
      throw err; // nobody knows whether it was posted
    }
    const url = made.map((c) => c.html_url).filter((u): u is string => typeof u === 'string').pop();
    throw url ? new PicturesPartly(why, url) : new PicturesNotPosted(why);
  }
}

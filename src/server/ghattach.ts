// A pull request's conversation comment with pictures attached (`gh pr comment --body-file … --attach …`): what the kanban's posted
// review uses when its findings show in UI-test pictures (a review itself cannot carry attachments). gh uploads the files and rewrites
// the body's `./name` references. It may also post the comment and still fail (some uploads failed), or fail before posting anything,
// so a failure is looked into before anyone posts again: the two errors below say which it was, any other error means nobody knows.

import { randomBytes } from 'node:crypto';
import { appendFile } from 'node:fs/promises';

type Run = (args: string[], cwd: string, timeout?: number, env?: Record<string, string>) => Promise<string>;

/** gh failed and the comment is certainly not there: posting again makes no duplicate. */
export class PicturesNotPosted extends Error {}

/** gh failed, but the comment is there (with the pictures that did upload): `url` is its address. */
export class PicturesPartly extends Error {
  constructor(message: string, readonly url: string) {
    super(message);
  }
}

/** gh never got as far as GitHub: its own word that nothing was posted, or a gh that does not know the command. */
const NEVER_SENT = /no comment was posted|unknown flag|unknown command|unknown shorthand|not installed on the server/i;

/**
 * Posts the comment and resolves to its URL. Rejects with PicturesNotPosted, PicturesPartly, or (the outcome unknown) gh's own error.
 * The body gets an invisible mark of this one posting at its end, so the look afterwards finds this comment and no earlier one with the
 * same text, on whatever page of the conversation it is. A gh that ran out of time may still have been heard by GitHub: finding nothing
 * then proves nothing, and the outcome stays unknown.
 */
export async function commentWithPictures(run: Run, repo: string, n: number, file: string, attach: readonly string[], cwd: string, env?: Record<string, string>, timeout = Math.min(600_000, 60_000 + attach.length * 10_000)): Promise<string> {
  const mark = `<!-- review ${randomBytes(8).toString('hex')} -->`;
  await appendFile(file, `\n\n${mark}\n`);
  // A little before now: the office's clock and GitHub's need not agree, and the mark decides which comment is ours.
  const started = Date.now(), since = new Date(started - 120_000).toISOString();
  try {
    const out = await run(['pr', 'comment', String(n), '--repo', repo, '--body-file', file, ...attach.flatMap((f) => ['--attach', f])], cwd, timeout, env);
    return out.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
  } catch (err) {
    const why = (err as Error).message;
    if (NEVER_SENT.test(why)) throw new PicturesNotPosted(why);
    const timedOut = Date.now() - started >= timeout - 1_000;
    let url: string | undefined;
    try {
      const raw = await run(['api', '--paginate', `repos/${repo}/issues/${n}/comments?since=${since}&per_page=100`, '--jq', `.[] | select((.body // "") | contains("${mark}")) | .html_url`], cwd, 60_000, env);
      url = raw.split('\n').map((l) => l.trim()).filter(Boolean).pop();
    } catch {
      throw err; // nobody knows whether it was posted
    }
    if (url) throw new PicturesPartly(why, url);
    if (timedOut) throw err;
    throw new PicturesNotPosted(why);
  }
}

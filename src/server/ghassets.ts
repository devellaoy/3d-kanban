// Fetches the pictures attached to GitHub issues and pull requests ("user attachments") with the
// asker's gh sign-in (the office's own for someone who acts as the office), since in a private
// repository their address only answers a signed-in session. An address is only a reference anyone can
// write into a comment, so two things hold: only ids the office itself saw in a repository's texts are
// asked for at all (see GhAssets.note), and GitHub decides with the asker's own access whether they get
// the picture (the route, http/routes/github.ts, never lends the office's token to an account or a visitor).

import { ghAssetIds, ghAssetUrl } from '../shared/ghassets.js';

const TIMEOUT_MS = 20_000;
/** The most a visitor relay carries in one answer (shared/multiplayer/wire.ts), so a picture any bigger would not arrive anyway. */
export const GH_ASSET_MAX_BYTES = 8 * 1024 * 1024;
const NOTED_MAX = 5000;
/** No SVG: it can carry script, and the office serves these from its own origin. */
const TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export type GhAssetResult = { type: string; body: Buffer } | { status: number; error: string };
type Run = (args: string[], cwd: string, timeout?: number, env?: Record<string, string>) => Promise<string>;

/** Where GitHub keeps the files behind an attachment: its user-content hosts and the S3 bucket of public repositories. */
function storageHost(u: URL): boolean {
  if (u.protocol !== 'https:' || u.port) return false;
  return u.hostname.endsWith('.githubusercontent.com') || /^github-production-user-asset-[a-z0-9]+\.s3\.amazonaws\.com$/.test(u.hostname);
}

const fail = (status: number, error: string): GhAssetResult => ({ status, error });

/** The body read up to the cap; undefined past it. */
async function readCapped(res: Response): Promise<Buffer | undefined> {
  if (Number(res.headers.get('content-length')) > GH_ASSET_MAX_BYTES) return undefined;
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > GH_ASSET_MAX_BYTES) {
      void reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function picture(res: Response): Promise<GhAssetResult> {
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!TYPES.has(type)) {
    void res.body?.cancel().catch(() => undefined);
    return fail(415, 'That attachment is not a picture the office shows');
  }
  const body = await readCapped(res);
  return body ? { type, body } : fail(413, 'That picture is too big');
}

export class GhAssets {
  private noted = new Set<string>();
  /** The fetches under way, by who asks and the id: a window asking for the same picture twice (it paints twice as it opens) shares one. */
  private flying = new Map<string, Promise<GhAssetResult>>();

  /** Remembers the attachments the texts hold, as the ones the office may fetch. The oldest go past the cap. */
  note(...texts: (string | undefined)[]): void {
    for (const t of texts) {
      if (!t) continue;
      for (const id of ghAssetIds(t)) {
        // Seen again: moved to the newest end.
        this.noted.delete(id);
        this.noted.add(id);
      }
    }
    while (this.noted.size > NOTED_MAX) this.noted.delete(this.noted.values().next().value as string);
  }

  has(id: string): boolean {
    return this.noted.has(id.toLowerCase());
  }

  /**
   * The picture behind an attachment's address, fetched with the gh sign-in `run` runs as. `who` names that sign-in
   * (an account's id, else the office), so one person's fetch is never another's answer. The token is read for this
   * one call and never kept or named in an error.
   */
  fetch(id: string, run: Run, dir: string, fetchImpl: typeof fetch = fetch, who = 'office'): Promise<GhAssetResult> {
    const key = `${who}\n${id}`;
    const going = this.flying.get(key);
    if (going) return going;
    const p = this.load(id, run, dir, fetchImpl).finally(() => this.flying.delete(key));
    this.flying.set(key, p);
    return p;
  }

  private async load(id: string, run: Run, dir: string, fetchImpl: typeof fetch): Promise<GhAssetResult> {
    let token: string;
    try {
      token = (await run(['auth', 'token', '--hostname', 'github.com'], dir)).trim();
    } catch {
      return fail(502, 'No GitHub sign-in to fetch the picture with');
    }
    if (!token) return fail(502, 'No GitHub sign-in to fetch the picture with');
    try {
      const first = await fetchImpl(ghAssetUrl(id), { redirect: 'manual', headers: { authorization: `token ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (first.status === 404) return fail(404, 'GitHub has no such attachment (or the office has no access to it)');
      if (first.status === 200) return await picture(first);
      const where = first.status >= 300 && first.status < 400 ? first.headers.get('location') : null;
      void first.body?.cancel().catch(() => undefined);
      if (!where) return fail(502, `GitHub answered ${first.status}`);
      let to: URL;
      try {
        to = new URL(where, ghAssetUrl(id));
      } catch {
        return fail(502, 'GitHub sent the picture somewhere unreadable');
      }
      if (!storageHost(to)) return fail(502, 'GitHub sent the picture somewhere the office does not fetch from');
      // The signed address carries its own permission: the token goes no further than github.com.
      const second = await fetchImpl(to.href, { redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (second.status === 404) return fail(404, 'GitHub has no such attachment');
      if (!second.ok) {
        void second.body?.cancel().catch(() => undefined);
        return fail(502, `GitHub's picture host answered ${second.status}`);
      }
      return await picture(second);
    } catch {
      return fail(502, 'The picture could not be fetched from GitHub');
    }
  }
}

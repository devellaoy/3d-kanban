// Pictures attached to a GitHub issue, pull request or comment ("user attachments"). In a private
// repository their address only answers a signed-in GitHub session, so the office fetches them itself
// (server/ghassets.ts) for the windows that show the text (client/ui/github/md.ts).

const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ONE_RE = new RegExp(`^https://github\\.com/user-attachments/assets/(${ID})$`, 'i');
const ALL_RE = new RegExp(`https://github\\.com/user-attachments/assets/(${ID})(?![0-9a-zA-Z-])`, 'gi');
const ID_RE = new RegExp(`^${ID}$`, 'i');

/** Whether `id` is an attachment's id (what /api/gh/asset?id= takes). */
export function isGhAssetId(id: string): boolean {
  return ID_RE.test(id);
}

/** The attachment's id when `src` is exactly an attachment's address, lower-cased. */
export function ghAssetId(src: string): string | undefined {
  return ONE_RE.exec(src.trim())?.[1].toLowerCase();
}

/** The ids of every attachment address in a text (a PR body, a comment), lower-cased. */
export function ghAssetIds(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(ALL_RE)) out.push(m[1].toLowerCase());
  return out;
}

/** The attachment's address on GitHub. */
export function ghAssetUrl(id: string): string {
  return `https://github.com/user-attachments/assets/${id}`;
}

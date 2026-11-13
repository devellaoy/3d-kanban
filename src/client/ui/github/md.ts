import { ghAssetId } from '../../../shared/ghassets';
import { markdown } from '../markdown';
import { ghSrc } from './api';
import { repoOfItem } from './ghrepo';

// The text of a pull request, an issue or a comment in the board's windows. A picture attached on
// GitHub (github.com/user-attachments/assets/<id>) loads straight from there in a public repository;
// in a private one that address only answers a signed-in GitHub session, so when it doesn't load the
// picture is asked from the office instead, which fetches it with its own sign-in (/api/gh/asset).

/** The repositories whose attached pictures only the office could load: their later pictures are asked from it straight away. */
const viaOffice = new Set<string>();

/** Markdown as ui/markdown.ts renders it, its attached pictures falling back to the office (see above). */
export function ghMarkdown(body: string, itemUrl?: string): HTMLElement {
  // The office only gives a picture it showed in that repository's texts, so without the item there's nowhere to ask.
  const repo = itemUrl ? repoOfItem({ url: itemUrl }) : '';
  if (!repo) return markdown(body, itemUrl);
  return markdown(body, itemUrl, {
    fallbackFirst: viaOffice.has(repo),
    onFallback: () => viaOffice.add(repo),
    imageFallback: (src) => {
      const id = ghAssetId(src);
      return id ? ghSrc(`/api/gh/asset?id=${id}`, repo) : undefined;
    },
  });
}

// Links in rendered kanban text (md.ts) that markdown itself doesn't make: a URL written as `code`
// (marked already links bare ones), and file paths, which open in VS Code on the office's machine
// through `openFile` (kanban.task.openFile; the office checks the file is one of the task's). The pure
// matching is exported for the tests.

import { h } from '../ui/dom';

/** A file path found in text: where it is, the path and the line it names. */
export interface PathHit {
  index: number;
  text: string;
  path: string;
  line?: number;
}

// A path with at least one folder, ending in a file name with an extension that starts with a letter
// (so 1/2.5 and v1.2 aren't paths); optionally :12, :12:3 or #L12 after it. Folders are split by / or,
// as on Windows, by \, and an absolute path may start with a drive (C:\repo\src\app.ts:42).
const SEG = String.raw`[\w@+-][\w.@+-]*`;
const SEP = String.raw`[\\/]`;
const LINE = String.raw`(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)?`;
const PATH_RE = new RegExp(String.raw`(^|[\s(\[{"'“‘,;=])((?:[A-Za-z]:${SEP}|\.{1,2}${SEP}|${SEP})?(?:${SEG}${SEP})+${SEG}\.[A-Za-z][\w]{0,9})${LINE}`, 'g');
/** A lone file name counts only as all of a `code` span, and only with an extension of a source or config file. */
const BARE_RE = new RegExp(String.raw`^(${SEG}\.(?:tsx?|jsx?|mjs|cjs|json|jsonc|md|mdx|css|scss|less|html?|vue|svelte|py|go|rs|java|kt|swift|rb|php|cs|c|h|cpp|hpp|ya?ml|toml|ini|sql|sh|ps1|xml|lock|gradle|env\.example))${LINE}$`);
const URL_RE = /^https?:\/\/[^\s<>"'`]+$/i;

/** Every path in a run of text (the line numbers parsed). */
export function findPaths(s: string): PathHit[] {
  const out: PathHit[] = [];
  PATH_RE.lastIndex = 0;
  for (let m = PATH_RE.exec(s); m; m = PATH_RE.exec(s)) {
    const index = m.index + m[1].length;
    const text = m[0].slice(m[1].length);
    // Not a domain's page (example.com/a.js, docs.github.com/en/a.md).
    if (/^(?:[\w-]+\.)+[a-z]{2,}\//i.test(m[2])) continue;
    const line = Number(m[3] ?? m[4]) || undefined;
    out.push({ index, text, path: m[2], ...(line ? { line } : {}) });
  }
  return out;
}

/** The whole of a `code` span as a path (or a lone source file name), else null. */
export function codePath(s: string): PathHit | null {
  const t = s.trim();
  const bare = BARE_RE.exec(t);
  if (bare) return { index: 0, text: t, path: bare[1], ...(Number(bare[2] ?? bare[3]) ? { line: Number(bare[2] ?? bare[3]) } : {}) };
  const hits = findPaths(t);
  return hits.length === 1 && hits[0].index === 0 && hits[0].text === t ? hits[0] : null;
}

export type OpenFile = (path: string, line?: number) => void;

function fileLink(hit: PathHit, openFile: OpenFile, content: Node | string): HTMLAnchorElement {
  const a = h('a.kb-file', { href: '#', title: `Open ${hit.path}${hit.line ? ` at line ${hit.line}` : ''} in VS Code on the office’s computer` }, content) as HTMLAnchorElement;
  a.addEventListener('click', (e) => {
    e.preventDefault();
    openFile(hit.path, hit.line);
  });
  return a;
}

/** Links the URLs in `code` spans, and with `openFile` the file paths in text and `code`, outside existing links and code blocks. */
export function linkPathsAndUrls(root: HTMLElement, openFile?: OpenFile): void {
  for (const code of root.querySelectorAll<HTMLElement>('code')) {
    if (code.closest('a, pre')) continue;
    const t = code.textContent ?? '';
    if (URL_RE.test(t.trim())) {
      const a = h('a', { href: t.trim(), target: '_blank', rel: 'noopener noreferrer' });
      code.replaceWith(a);
      a.append(code);
      continue;
    }
    const hit = openFile ? codePath(t) : null;
    if (!hit || !openFile) continue;
    const a = fileLink(hit, openFile, '');
    code.replaceWith(a);
    a.append(code);
  }
  if (!openFile) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('a, code, pre') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const texts: Text[] = [];
  while (walker.nextNode()) texts.push(walker.currentNode as Text);
  for (const node of texts) {
    const hits = findPaths(node.data);
    if (!hits.length) continue;
    const frag = document.createDocumentFragment();
    let at = 0;
    for (const hit of hits) {
      frag.append(node.data.slice(at, hit.index), fileLink(hit, openFile, hit.text));
      at = hit.index + hit.text.length;
    }
    frag.append(node.data.slice(at));
    node.replaceWith(frag);
  }
}

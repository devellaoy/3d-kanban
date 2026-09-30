// Markdown in the kanban: upstream's renderer (marked + DOMPurify, ui/markdown.ts), with #123 turned
// into a link to that task's detail rather than a GitHub issue.

import { h } from '../ui/dom';
import { markdown } from '../ui/markdown';
import { splitTaskRefs } from './attach';
import { deepLink } from './model';

/** Rendered markdown, its #123 references opening the task in the detail panel. */
export function renderMarkdown(src: string, openTask: (id: number) => void, empty = 'No description.'): HTMLElement {
  if (!src.trim()) return h('div.md', {}, h('p.none', {}, empty));
  const el = markdown(src);
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('a, code, pre') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const texts: Text[] = [];
  while (walker.nextNode()) texts.push(walker.currentNode as Text);
  for (const node of texts) {
    const parts = splitTaskRefs(node.data);
    if (parts.length === 1 && typeof parts[0] === 'string') continue;
    const frag = document.createDocumentFragment();
    for (const p of parts) {
      if (typeof p === 'string') frag.append(p);
      else {
        // Off the kanban page (a task view in the 3D office) the link still goes to the task on the kanban.
        const href = location.pathname.startsWith('/kanban') ? deepLink(location.search, { task: p.task }) : `/kanban?task=${p.task}`;
        const a = h('a.kb-ref', { href, title: `Open task #${p.task}` }, p.text);
        a.addEventListener('click', (e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey) return;
          e.preventDefault();
          openTask(p.task);
        });
        frag.append(a);
      }
    }
    node.replaceWith(frag);
  }
  return el;
}

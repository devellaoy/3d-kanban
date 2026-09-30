// Markdown in the kanban: upstream's renderer (marked + DOMPurify, ui/markdown.ts), with #123 turned
// into a link to that task's detail rather than a GitHub issue.

import { h } from '../ui/dom';
import { markdown } from '../ui/markdown';
import { splitTaskRefs } from './attach';
import { deepLink } from './model';
import { t } from './i18n';

/** Rendered markdown, its #123 references opening the task in the detail panel. */
export function renderMarkdown(src: string, openTask: (id: number) => void, empty = t('noDescription')): HTMLElement {
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
        const a = h('a.kb-ref', { href: deepLink(location.search, { task: p.task }), title: t('openTaskN', { id: p.task }) }, p.text);
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

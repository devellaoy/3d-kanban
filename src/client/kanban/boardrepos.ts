// A project's issues and PR boards can hold items from several repositories (a multi-repo project):
// a chip naming each card's repository and a filter by it, for upstream's ui/boards.ts. An item's
// repository is its `repo` when the office sends one, else read off its GitHub URL.

import { h } from '../ui/dom';
import { repoOfItem } from './ghrepo';
import { officeCss } from './officecss';

// It lives with the other repository helpers (ghrepo.ts), which the office's state.ts imports too.
export { repoOfItem };

/** The repositories a board's items come from, sorted. */
export function boardRepos(items: { url: string; repo?: string }[]): string[] {
  return [...new Set(items.map(repoOfItem).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

/** Only the items of `repo` ('' = all of them). */
export function inRepo<T extends { url: string; repo?: string }>(items: T[], repo: string): T[] {
  return repo ? items.filter((it) => repoOfItem(it) === repo) : items;
}

/** The chip on a card: the repository's name (the owner is the same across a project, mostly). */
export function repoChip(it: { url: string; repo?: string }): HTMLElement {
  officeCss();
  const full = repoOfItem(it);
  return h('span.repo-chip', { title: full }, `📦 ${full.split('/').pop() ?? full}`);
}

function key(kind: string, floor: string): string {
  return `agent-office.board-repo.${floor}.${kind}`;
}

/** The repository a board was last filtered to, per floor and board. */
export function loadRepoFilter(kind: string, floor: string): string {
  try {
    return localStorage.getItem(key(kind, floor)) ?? '';
  } catch {
    return '';
  }
}

export function saveRepoFilter(kind: string, floor: string, repo: string) {
  try {
    if (repo) localStorage.setItem(key(kind, floor), repo);
    else localStorage.removeItem(key(kind, floor));
  } catch {
    // storage blocked
  }
}

/** The filter box for the board's header: hidden while everything is from one repository. */
export function repoFilterSelect(repos: string[], value: string, onChange: (repo: string) => void): HTMLSelectElement {
  officeCss();
  const sel = h('select.board-repo', { 'aria-label': 'Repository', title: 'Only one repository’s cards' }) as HTMLSelectElement;
  sel.append(h('option', { value: '' }, '📦 All repositories'), ...repos.map((r) => h('option', { value: r }, `📦 ${r}`)));
  sel.value = repos.includes(value) ? value : '';
  sel.classList.toggle('hidden', repos.length < 2);
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

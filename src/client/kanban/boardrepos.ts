// A project's issues and PR boards can hold items from several repositories (a multi-repo project):
// a chip naming each card's repository and a filter by it, for upstream's ui/boards.ts. An item's
// repository is its `repo` when the office sends one, else read off its GitHub URL.

import { h } from '../ui/dom';
import { sameRepo } from '../../shared/floors';
import { repoOfItem } from './ghrepo';
import { officeCss } from './officecss';

// It lives with the other repository helpers (ghrepo.ts), which the office's state.ts imports too.
export { repoOfItem };

/** The repositories a board's items come from, sorted. */
export function boardRepos(items: { url: string; repo?: string }[]): string[] {
  return [...new Set(items.map(repoOfItem).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

/**
 * The PR board's tabs: the repositories its items come from plus the project's `configured` ones
 * (which may have no pull requests), sorted and de-duplicated ignoring case.
 */
export function tabRepos(items: { url: string; repo?: string }[], configured: string[] = []): string[] {
  const seen = new Map<string, string>();
  for (const r of [...boardRepos(items), ...configured]) if (r && !seen.has(r.toLowerCase())) seen.set(r.toLowerCase(), r);
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * The repository a kept choice still means: `value` (in the spelling of the list) while it is a tab
 * or one of the project's `configured` repositories, else '' (All). Without `configured` (a one-repo
 * floor, an older server) a repository that has no cards is stale. Judged by the configuration, not
 * the cards, so an empty or failed load keeps the choice.
 */
export function keptRepo(value: string, repos: string[], configured?: string[]): string {
  if (!value) return '';
  return [...repos, ...(configured ?? [])].find((r) => sameRepo(r, value)) ?? '';
}

/** How many of the items are open, per repository, for the PR board's tabs. */
export function openByRepo(items: { url: string; repo?: string; state: string }[]): Map<string, number> {
  const n = new Map<string, number>();
  for (const it of items) if (it.state === 'OPEN') n.set(repoOfItem(it), (n.get(repoOfItem(it)) ?? 0) + 1);
  return n;
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

/**
 * The PR board's repository tabs, below its header: 📦 All, then one per repository with its open PRs.
 * `update` keeps the buttons it already has (keyed by repository), so focus survives the board's
 * re-renders. A kept choice whose repository has no PRs still shows, picked, as long as the repository is
 * in the project (boards.ts decides that with keptRepo), rather than quietly falling back to All. Hidden while there's only one repository.
 */
export function repoTabs(onChange: (repo: string) => void): { el: HTMLElement; update(repos: string[], value: string, counts: Map<string, number>, total: number): void } {
  officeCss();
  const el = h('div.board-repo-tabs.hidden', { role: 'tablist', 'aria-label': 'Repositories' });
  const tabs = new Map<string, HTMLButtonElement>();
  let picked: string | null = null;
  const tabOf = (repo: string) => {
    let b = tabs.get(repo);
    if (!b) {
      b = h('button.board-repo-tab', { type: 'button', role: 'tab', 'data-repo': repo }, h('span'), h('small')) as HTMLButtonElement;
      b.addEventListener('click', () => onChange(repo));
      tabs.set(repo, b);
    }
    return b;
  };
  el.addEventListener('keydown', (e) => {
    const list = [...el.children] as HTMLButtonElement[];
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const to = e.key === 'ArrowRight' ? (at + 1) % list.length : e.key === 'ArrowLeft' ? (at - 1 + list.length) % list.length : e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    e.stopPropagation();
    list[to].focus();
    onChange(list[to].dataset.repo ?? '');
  });
  return {
    el,
    update(repos, value, counts, total) {
      const shown = value && !repos.includes(value) ? [...repos, value].sort((a, b) => a.localeCompare(b)) : repos;
      const order = ['', ...shown];
      for (const [repo, b] of tabs) if (!order.includes(repo)) (b.remove(), tabs.delete(repo));
      order.forEach((repo, i) => {
        const b = tabOf(repo);
        const name = repo ? (repo.split('/').pop() ?? repo) : '📦 All';
        const n = repo ? (counts.get(repo) ?? 0) : total;
        const [label, count] = b.children as unknown as [HTMLElement, HTMLElement];
        if (label.textContent !== name) label.textContent = name;
        if (count.textContent !== String(n)) count.textContent = String(n);
        b.title = repo ? `${repo}: ${n} open` : `Every repository: ${n} open`;
        b.setAttribute('aria-label', `${repo || 'All repositories'}, ${n} open pull request${n === 1 ? '' : 's'}`);
        b.setAttribute('aria-selected', String(repo === value));
        b.tabIndex = repo === value ? 0 : -1;
        if (el.children[i] !== b) el.insertBefore(b, el.children[i] ?? null);
      });
      el.classList.toggle('hidden', shown.length < 2);
      // A newly picked tab scrolls into sight in a narrow row (a phone, many repositories).
      if (picked !== value) (picked = value), tabs.get(value)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    },
  };
}

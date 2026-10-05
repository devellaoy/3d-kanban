// The PR board's "whose" filter (gh:devellaoy/3d-kanban#123): every pull request, only mine, or the
// ones waiting on my review, beside the repository tabs, for ui/boards.ts. "Mine" is a PR authored by
// my GitHub login, or one the office opened on my behalf: from a kanban task I made, a worker I hired
// at a desk, or with "Opened from Agent Office by <me>" in its description. The choice is this
// browser's, the same on every floor.

import { h } from '../ui/dom';
import type { Net } from '../net';
import { sameRepo } from '../../shared/floors';
import type { GhPull, SignInsState, WorkerInfo } from '../../shared/protocol';
import type { KanbanServerMsg } from '../../shared/kanban/protocol.js';
import type { KanbanTaskCard } from '../../shared/kanban/types.js';
import { kanbanApi } from './api';
import { repoOfItem } from './boardrepos';
import { officeCss } from './officecss';

export type PrWho = 'all' | 'mine' | 'review';
const WHOS: readonly PrWho[] = ['all', 'mine', 'review'];

/**
 * My GitHub login: my own sign-in's, when I have one; the office's own gh (`officeViewer`) when I use
 * the office's sign-in or there are no accounts (`signins` null). An account without a GitHub sign-in
 * has none, so the office's PRs don't all count as everyone's.
 */
export function myLogin(signins: Pick<SignInsState, 'github'> | null, officeViewer: string | undefined): string {
  const gh = signins?.github;
  if (!signins || gh?.how === 'office') return officeViewer ?? '';
  return gh?.status === 'ok' && gh.who ? gh.who.replace(/^@/, '').trim() : '';
}

/** Who the office's own drafted PR says opened it: "_Opened from Agent Office by NAME · …_" (server/workers/pr.ts). */
export function openedFromOfficeBy(body: string): string | undefined {
  return /_Opened from Agent Office by (.+?) · /.exec(body)?.[1];
}

const same = (a: string, b: string) => !!a && a.toLowerCase() === b.toLowerCase();

/** The PR is one of a task's linked ones (by its link, else by repository and number). */
function linksTo(task: Pick<KanbanTaskCard, 'prs'>, pr: GhPull): boolean {
  const url = pr.url.toLowerCase();
  return task.prs.some((l) => (l.url && l.url.toLowerCase() === url) || (l.number === pr.number && !!l.repo && sameRepo(l.repo, repoOfItem(pr))));
}

export interface Me {
  /** My GitHub login (myLogin); '' when unknown. */
  login: string;
  /** My name in the office, as kanban tasks and workers record who made them; '' when unknown. */
  name: string;
  /** The project's kanban tasks (kanban.snapshot). */
  tasks: Pick<KanbanTaskCard, 'prs' | 'createdBy'>[];
  workers: Iterable<WorkerInfo>;
  /** Which worker a PR came from (state.ts workerForPull). */
  workerOf: (workers: Iterable<WorkerInfo>, pr: GhPull) => WorkerInfo | undefined;
}

/** Whether a pull request is mine: authored by my login or opened by the office on my behalf. */
export function minePredicate(me: Me): (pr: GhPull) => boolean {
  const workers = [...me.workers];
  const mine = me.name ? me.tasks.filter((t) => t.createdBy === me.name) : [];
  return (pr) => {
    if (same(me.login, pr.author)) return true;
    if (!me.name) return false;
    if (mine.some((t) => linksTo(t, pr))) return true;
    const w = me.workerOf(workers, pr);
    if (w?.byPerson && w.createdBy === me.name) return true;
    return openedFromOfficeBy(pr.body ?? '') === me.name;
  };
}

/** Whether my review is asked for on a pull request. */
export function reviewPredicate(login: string): (pr: GhPull) => boolean {
  return (pr) => !!login && !!pr.reviewRequests?.some((l) => same(l, login));
}

const KEY = 'agent-office.board-pulls-who';

export function loadPrWho(): PrWho {
  try {
    const v = localStorage.getItem(KEY);
    return WHOS.includes(v as PrWho) ? (v as PrWho) : 'all';
  } catch {
    return 'all';
  }
}

export function savePrWho(who: PrWho) {
  try {
    if (who === 'all') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, who);
  } catch {
    // storage blocked
  }
}

/** The board's empty note while a filter leaves no open PRs ('' when there's nothing to say). */
export function emptyNote(who: PrWho, repo: string, open: number): string {
  if (who === 'all' || open > 0) return '';
  const where = repo ? ` in ${repo.split('/').pop() ?? repo}` : '';
  return who === 'mine' ? `You have no open pull requests${where}` : `Nothing${where} is waiting for your review`;
}

const LABEL: Record<PrWho, string> = { all: 'All', mine: '👤 Mine', review: '👀 To review' };
const TITLE: Record<PrWho, string> = {
  all: 'Everyone’s pull requests',
  mine: 'Pull requests by your GitHub account, or opened from the office for you (your kanban tasks and workers)',
  review: 'Pull requests whose review is asked of your GitHub account',
};

/**
 * The All / 👤 Mine / 👀 To review buttons. `update` marks the picked one and turns off the ones that
 * can't work (with why, as their title). ← → move between them, like the repository tabs.
 */
export function prWhoToggle(onChange: (who: PrWho) => void): { el: HTMLElement; update(value: PrWho, off: Partial<Record<PrWho, string>>): void } {
  officeCss();
  const el = h('div.board-who', { role: 'radiogroup', 'aria-label': 'Whose pull requests' });
  const buttons = WHOS.map((who) => {
    const b = h('button.board-who-opt', { type: 'button', role: 'radio', 'data-who': who }, LABEL[who]) as HTMLButtonElement;
    b.addEventListener('click', () => onChange(who));
    el.append(b);
    return b;
  });
  el.addEventListener('keydown', (e) => {
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (at < 0 || !step) return;
    e.preventDefault();
    e.stopPropagation();
    for (let i = 1; i < buttons.length; i++) {
      const b = buttons[(at + step * i + buttons.length) % buttons.length];
      if (b.disabled) continue;
      b.focus();
      onChange(b.dataset.who as PrWho);
      return;
    }
  });
  return {
    el,
    update(value, off) {
      for (const b of buttons) {
        const who = b.dataset.who as PrWho;
        b.disabled = !!off[who];
        b.title = off[who] ?? TITLE[who];
        b.setAttribute('aria-checked', String(who === value));
        b.tabIndex = who === value ? 0 : -1;
      }
    },
  };
}

/** The row under the PR board's header: the repository tabs (hidden on a one-repository floor) and the toggle. */
export function prFilterBar(tabs: HTMLElement, toggle: HTMLElement): HTMLElement {
  officeCss();
  return h('div.board-pr-bar', {}, tabs, toggle);
}

type Snapshot = Extract<KanbanServerMsg, { t: 'kanban.snapshot' }>;

/**
 * The floor's kanban tasks and my name as the kanban knows it, for "mine": a kanban.snapshot (never
 * kanban.subscribe, which would take the connection's delta filter), asked again by `refresh` at most
 * every 30 seconds. A failure leaves what it had; login matches work without it.
 */
export function mineTasks(net: Net, project: () => string | null | undefined, changed: () => void) {
  let tasks: KanbanTaskCard[] = [];
  let name = '';
  let asked = 0;
  let stopped = false;
  return {
    tasks: () => tasks,
    name: () => name,
    refresh() {
      const p = project();
      if (stopped || !p || Date.now() - asked < 30_000) return;
      asked = Date.now();
      kanbanApi(net)
        .request<Snapshot>({ t: 'kanban.snapshot', project: p })
        .then((s) => {
          if (stopped) return;
          tasks = s.tasks;
          name = s.me.name;
          changed();
        })
        .catch(() => {});
    },
    stop: () => void (stopped = true),
  };
}

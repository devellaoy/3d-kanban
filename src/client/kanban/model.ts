// What the board shows, worked out without the DOM: which cards match the filters, in what order each
// column lists them, where a card may be dropped (from shared/kanban/moves.ts, which the server
// enforces too), and the words on a card's badges. Kept pure so tests/kanban-ui-*.test.ts can run it.

import { BOARD_COLUMNS, SKILL_PHASES, type KanbanPrBundleItem, type KanbanProjectInfo, type KanbanSettings, type NormalizedIssue, type PrRef, type KanbanTaskCard, type KanbanTool, type TaskStatus, type WaitingReason } from '../../shared/kanban/types.js';
import { checkMove, isRunning, moveTargets, type MoveAction, type MoveSubject } from '../../shared/kanban/moves.js';
import { REPO_ID_RE } from '../../shared/kanban/protocol.js';

// --- Filters --------------------------------------------------------------------------------------

/** What the board narrows to, besides the project picked in the top bar. */
export type StateFilter = 'all' | 'running' | 'attention' | 'retrying' | 'has_pr';
export const STATE_FILTERS: readonly StateFilter[] = ['all', 'running', 'attention', 'retrying', 'has_pr'];
export type TicketFilter = 'any' | 'with' | 'without';
export const TICKET_FILTERS: readonly TicketFilter[] = ['any', 'with', 'without'];

export interface BoardFilter {
  /** Free text: #id, words of the title, the ticket, a tag or a repository's name. */
  q: string;
  /** ProjectRepo ids; a card matches when it works in any of them. Empty: any. */
  repos: string[];
  state: StateFilter;
  /** Empty: any tool. */
  tools: KanbanTool[];
  ticket: TicketFilter;
}

export const EMPTY_FILTER: BoardFilter = { q: '', repos: [], state: 'all', tools: [], ticket: 'any' };

/** The waiting reasons that need a person to do something (a retry after a usage limit doesn't). */
export const ATTENTION_REASONS: readonly WaitingReason[] = ['plan_questions', 'plan_approval', 'agent_asking', 'stopped', 'failed', 'interrupted'];

/** Whether the task waits on a person. */
export function needsAttention(card: Pick<KanbanTaskCard, 'status' | 'waitingReason'>): boolean {
  return card.status === 'waiting' && !!card.waitingReason && ATTENTION_REASONS.includes(card.waitingReason);
}

/**
 * The ids of the repositories a card works in: all of its project's, or its subset, which always has
 * the primary one in it (the engine works in the floor's own checkout whatever was picked).
 */
export function cardRepoIds(card: Pick<KanbanTaskCard, 'repoIds'>, project?: Pick<KanbanProjectInfo, 'repos'>): string[] {
  if (!card.repoIds) return project?.repos.map((r) => r.id) ?? [];
  const primary = project?.repos.find((r) => r.primary)?.id;
  return primary && !card.repoIds.includes(primary) ? [primary, ...card.repoIds] : card.repoIds;
}

/** Whether two repository picks come to the same repositories (null = all, the primary one always in). */
export function sameRepoPick(a: string[] | null | undefined, b: string[] | null | undefined, project?: Pick<KanbanProjectInfo, 'repos'>): boolean {
  const ids = (repoIds: string[] | null | undefined) => [...new Set(cardRepoIds({ repoIds: repoIds ?? null }, project))].sort().join('\n');
  return ids(a) === ids(b);
}

/** The names of the repositories a card works in, for its chips and the search. */
export function cardRepoNames(card: Pick<KanbanTaskCard, 'repoIds'>, project?: Pick<KanbanProjectInfo, 'repos'>): string[] {
  const ids = cardRepoIds(card, project);
  return ids.map((id) => project?.repos.find((r) => r.id === id)?.name ?? id);
}

/** Whether a card is worth chips for its repositories: the project has more than one, or the task picked some. */
export function showsRepoChips(card: Pick<KanbanTaskCard, 'repoIds'>, project?: Pick<KanbanProjectInfo, 'repos'>): boolean {
  return project ? project.repos.length > 1 : !!card.repoIds?.length;
}

/** The words of a search, lower-cased; `#12` also matches the task number 12. */
export function searchWords(q: string): string[] {
  return q.toLowerCase().split(/\s+/).filter(Boolean);
}

export function matchesFilter(card: KanbanTaskCard, f: BoardFilter, project?: KanbanProjectInfo): boolean {
  if (f.tools.length && !f.tools.includes(card.tool)) return false;
  if (f.ticket === 'with' && !card.ticket) return false;
  if (f.ticket === 'without' && card.ticket) return false;
  if (f.repos.length) {
    const ids = cardRepoIds(card, project);
    if (!ids.some((id) => f.repos.includes(id))) return false;
  }
  switch (f.state) {
    case 'running':
      if (!isRunning(card)) return false;
      break;
    case 'attention':
      if (!needsAttention(card)) return false;
      break;
    case 'retrying':
      if (card.waitingReason !== 'usage_limit' && card.retryAt === undefined) return false;
      break;
    case 'has_pr':
      if (!card.prs.length) return false;
      break;
  }
  const words = searchWords(f.q);
  if (!words.length) return true;
  const hay = [`#${card.id}`, String(card.id), card.title, card.ticket ?? '', ...card.tags, ...cardRepoNames(card, project), project?.name ?? '', card.createdBy]
    .join('\n')
    .toLowerCase();
  return words.every((w) => (/^#\d+$/.test(w) ? card.id === Number(w.slice(1)) : hay.includes(w)));
}

/** Whether any filter is on (the board then says how many cards it hides). */
export function filterActive(f: BoardFilter): boolean {
  return !!f.q.trim() || f.repos.length > 0 || f.state !== 'all' || f.tools.length > 0 || f.ticket !== 'any';
}

// --- Columns and their order ----------------------------------------------------------------------

/**
 * A column's cards in order. To do: oldest first, as they'd be started. Waiting: the ones that need
 * someone before the ones only waiting to retry, longest-waiting first. Everywhere else: latest change first.
 */
export function sortCards(cards: KanbanTaskCard[], column: TaskStatus): KanbanTaskCard[] {
  const out = [...cards];
  if (column === 'todo') return out.sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  if (column === 'waiting') {
    return out.sort((a, b) => Number(needsAttention(b)) - Number(needsAttention(a)) || a.updatedAt - b.updatedAt || a.id - b.id);
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id);
}

/** The board's cards per column (and the archive's), filtered and in order. */
export function columnsOf(cards: Iterable<KanbanTaskCard>, f: BoardFilter, projects: KanbanProjectInfo[], project: string | null): Record<TaskStatus, KanbanTaskCard[]> {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const out: Record<TaskStatus, KanbanTaskCard[]> = { todo: [], in_progress: [], waiting: [], review: [], done: [], archived: [] };
  for (const c of cards) {
    if (project && c.project !== project) continue;
    if (!matchesFilter(c, f, byId.get(c.project))) continue;
    out[c.status].push(c);
  }
  for (const k of Object.keys(out) as TaskStatus[]) out[k] = sortCards(out[k], k);
  return out;
}

export interface BoardStats {
  total: number;
  running: number;
  attention: number;
  review: number;
  done: number;
}

export function boardStats(cards: Iterable<KanbanTaskCard>, project: string | null): BoardStats {
  const s: BoardStats = { total: 0, running: 0, attention: 0, review: 0, done: 0 };
  for (const c of cards) {
    if (project && c.project !== project) continue;
    if (c.status === 'archived') continue;
    s.total++;
    if (isRunning(c)) s.running++;
    if (needsAttention(c)) s.attention++;
    if (c.status === 'review') s.review++;
    if (c.status === 'done') s.done++;
  }
  return s;
}

// --- Moving cards ---------------------------------------------------------------------------------

export function moveSubject(card: Pick<KanbanTaskCard, 'status' | 'runState' | 'workerId' | 'reviewerWorkerId'>): MoveSubject {
  return { status: card.status, runState: card.runState, hasWorker: !!(card.workerId || card.reviewerWorkerId) };
}

/** Where a dragged card lights up: every board column (and the archive) with whether it takes the card, and why not. */
export function dropZones(card: Pick<KanbanTaskCard, 'status' | 'runState' | 'workerId' | 'reviewerWorkerId'>): { to: TaskStatus; ok: boolean; reason?: string; action?: MoveAction }[] {
  const subject = moveSubject(card);
  return [...BOARD_COLUMNS, 'archived' as const]
    .filter((to) => to !== card.status)
    .map((to) => {
      const c = checkMove(subject, to);
      return c.ok ? { to, ok: true, action: c.action } : { to, ok: false, reason: c.reason };
    });
}

/** Just the columns a card may go to. */
export function dropTargets(card: Pick<KanbanTaskCard, 'status' | 'runState' | 'workerId' | 'reviewerWorkerId'>): TaskStatus[] {
  return moveTargets(moveSubject(card));
}

// --- Badges ---------------------------------------------------------------------------------------

/** "review 2/3", "fix 1/3", "plan": the phase a card is in (or last ran), with the round where it has one. */
export function phaseBadge(card: Pick<KanbanTaskCard, 'phase' | 'reviewRound' | 'reviewRounds' | 'useReview'>): { phase: string; round?: string } | null {
  if (!card.phase) return null;
  if ((card.phase === 'review' || card.phase === 'fix') && card.useReview && card.reviewRound > 0) {
    return { phase: card.phase, round: `${card.reviewRound}/${Math.max(card.reviewRounds, card.reviewRound)}` };
  }
  return { phase: card.phase };
}

/** How long until `at`: "45 s", "4 min 05 s", "2 h 10 min"; `now` for "now". Units come from the caller's language. */
export function countdown(at: number, now: number, units: { s: string; min: string; h: string; now: string } = { s: 's', min: 'min', h: 'h', now: 'now' }): string {
  const left = Math.ceil((at - now) / 1000);
  if (left <= 0) return units.now;
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = left % 60;
  if (h) return `${h} ${units.h} ${String(m).padStart(2, '0')} ${units.min}`;
  if (m) return `${m} ${units.min} ${String(s).padStart(2, '0')} ${units.s}`;
  return `${s} ${units.s}`;
}

/** The PR states worth a color on the card. */
export function prTone(state: KanbanTaskCard['prs'][number]['state']): 'open' | 'draft' | 'merged' | 'closed' {
  return state === 'OPEN' ? 'open' : state === 'DRAFT' ? 'draft' : state === 'MERGED' ? 'merged' : 'closed';
}

// --- The URL --------------------------------------------------------------------------------------

/** `?task=12` opens its detail; `?project=api` picks the project. Whatever else is there stays. */
export function parseDeepLink(search: string): { task?: number; project?: string; settings: boolean } {
  const q = new URLSearchParams(search);
  const task = Number(q.get('task'));
  const project = q.get('project') ?? undefined;
  return { ...(Number.isSafeInteger(task) && task > 0 ? { task } : {}), ...(project && /^[a-z0-9-]{1,40}$/.test(project) ? { project } : {}), settings: q.has('settings') };
}

/** The page's query with the open task (and project) in it, for history.replaceState. */
export function deepLink(search: string, set: { task?: number | null; project?: string | null }): string {
  const q = new URLSearchParams(search);
  if (set.task !== undefined) {
    if (set.task) q.set('task', String(set.task));
    else q.delete('task');
  }
  if (set.project !== undefined) {
    if (set.project) q.set('project', set.project);
    else q.delete('project');
  }
  q.delete('settings');
  const s = q.toString();
  return s ? `?${s}` : '';
}

// --- Issues ---------------------------------------------------------------------------------------

/** Which of a list's issues pass the chips and the search. */
export function filterIssues(items: NormalizedIssue[], f: { q: string; source: string; status: string; label: string; assignee: string }): NormalizedIssue[] {
  const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter(
    (i) =>
      (!f.source || i.source === f.source) &&
      (!f.status || (i.status ?? '') === f.status) &&
      (!f.label || i.labels.includes(f.label)) &&
      (!f.assignee || (i.assignee ?? '') === f.assignee) &&
      words.every((w) => `${i.key}\n${i.title}\n${i.epic ?? ''}\n${i.repo ?? ''}`.toLowerCase().includes(w)),
  );
}

// --- The PR review picker -------------------------------------------------------------------------

/** One PR's key, the same for any way of writing its repository. */
export const refKey = (p: PrRef) => `${p.repo.toLowerCase()}#${p.number}`;

/** What the picker lists, in order: this PR, the rest of its bundle, then the project's other open PRs. */
export function pickerRows(self: PrRef & { title: string; url: string }, bundle: KanbanPrBundleItem[], others: { repo: string; number: number; title: string; url: string }[]) {
  const seen = new Set([refKey(self)]);
  const fresh = (p: PrRef) => {
    const k = refKey(p);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  };
  return { self, related: bundle.filter(fresh), rest: others.filter(fresh) };
}

// --- Settings -------------------------------------------------------------------------------------

/** A short repository id from its folder or name: lower-case letters, digits and dashes. */
export function repoIdFrom(name: string, taken: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 16) || 'repo';
  let id = /^[a-z0-9]/.test(base) ? base : `r${base}`.slice(0, 16);
  for (let n = 2; taken.has(id); n++) id = `${base.slice(0, 16)}-${n}`;
  return REPO_ID_RE.test(id) ? id : `repo-${taken.size + 1}`;
}

/** Which projects pick a skill (by name and tool), for the list. */
export function skillUsage(settings: Pick<KanbanSettings, 'projects'>, name: string, tool: KanbanTool): string[] {
  return Object.entries(settings.projects)
    .filter(([, p]) => SKILL_PHASES.some((ph) => p.skills[ph]?.[tool]?.includes(name)))
    .map(([id]) => id);
}

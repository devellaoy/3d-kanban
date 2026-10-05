// What the board shows, worked out without the DOM: which cards match the filters, in what order each
// column lists them, where a card may be dropped (from shared/kanban/moves.ts, which the server
// enforces too), and the words on a card's badges. Kept pure so tests/kanban-ui-*.test.ts can run it.

import { BOARD_COLUMNS, SKILL_PHASES, type KanbanEvent, type KanbanPrBundleItem, type KanbanProjectInfo, type KanbanSettings, type NormalizedIssue, type PrRef, type KanbanTaskCard, type KanbanTool, type TaskStatus, type WaitingReason } from '../../shared/kanban/types.js';
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

/** The names of the repositories a card works in, for the task view and the search. */
export function cardRepoNames(card: Pick<KanbanTaskCard, 'repoIds'>, project?: Pick<KanbanProjectInfo, 'repos'>): string[] {
  const ids = cardRepoIds(card, project);
  return ids.map((id) => project?.repos.find((r) => r.id === id)?.name ?? id);
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
 * someone before the ones only waiting to retry, longest-waiting first. On hold: the longest on hold first.
 * Everywhere else: latest change first.
 */
export function sortCards(cards: KanbanTaskCard[], column: TaskStatus): KanbanTaskCard[] {
  const out = [...cards];
  if (column === 'todo') return out.sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  if (column === 'waiting') {
    return out.sort((a, b) => Number(needsAttention(b)) - Number(needsAttention(a)) || a.updatedAt - b.updatedAt || a.id - b.id);
  }
  if (column === 'on_hold') return out.sort((a, b) => (a.hold?.at ?? a.updatedAt) - (b.hold?.at ?? b.updatedAt) || a.id - b.id);
  return out.sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id);
}

/** The board's cards per column (and the archive's), filtered and in order. */
export function columnsOf(cards: Iterable<KanbanTaskCard>, f: BoardFilter, projects: KanbanProjectInfo[], project: string | null): Record<TaskStatus, KanbanTaskCard[]> {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const out: Record<TaskStatus, KanbanTaskCard[]> = { todo: [], in_progress: [], waiting: [], review: [], on_hold: [], done: [], archived: [] };
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

export function moveSubject(card: Pick<KanbanTaskCard, 'status' | 'runState'>): MoveSubject {
  return { status: card.status, runState: card.runState };
}

/** Where a dragged card lights up: every board column (and the archive) with whether it takes the card, and why not. */
export function dropZones(card: Pick<KanbanTaskCard, 'status' | 'runState'>): { to: TaskStatus; ok: boolean; reason?: string; action?: MoveAction }[] {
  const subject = moveSubject(card);
  return [...BOARD_COLUMNS, 'archived' as const]
    .filter((to) => to !== card.status)
    .map((to) => {
      const c = checkMove(subject, to);
      return c.ok ? { to, ok: true, action: c.action } : { to, ok: false, reason: c.reason };
    });
}

/** Just the columns a card may go to. */
export function dropTargets(card: Pick<KanbanTaskCard, 'status' | 'runState'>): TaskStatus[] {
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

/** How long until `at`: "45 s", "4 min 05 s", "2 h 10 min"; `now` for "now". The caller can name the units. */
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

/**
 * `?task=12` opens its detail (`&tab=changes` on that tab); `?project=api` picks the project.
 * Whatever else is there stays.
 */
export function parseDeepLink(search: string): { task?: number; project?: string; tab?: TaskTab; settings: boolean } {
  const q = new URLSearchParams(search);
  const task = Number(q.get('task'));
  const project = q.get('project') ?? undefined;
  const tab = q.get('tab');
  const hasTask = Number.isSafeInteger(task) && task > 0;
  return {
    ...(hasTask ? { task } : {}),
    ...(project && /^[a-z0-9-]{1,40}$/.test(project) ? { project } : {}),
    // A tab is only a tab of a task: without one it means nothing.
    ...(hasTask && isTaskTab(tab) ? { tab } : {}),
    settings: q.has('settings'),
  };
}

/** The page's query with the open task (its tab) and project in it, for history.replaceState. */
export function deepLink(search: string, set: { task?: number | null; project?: string | null; tab?: TaskTab | null }): string {
  const q = new URLSearchParams(search);
  if (set.task !== undefined) {
    if (set.task) q.set('task', String(set.task));
    else {
      q.delete('task');
      q.delete('tab');
    }
  }
  if (set.tab !== undefined) {
    // Overview is where a task opens anyway: the link stays short.
    if (set.tab && set.tab !== 'overview' && q.has('task')) q.set('tab', set.tab);
    else q.delete('tab');
  }
  if (set.project !== undefined) {
    if (set.project) q.set('project', set.project);
    else q.delete('project');
  }
  q.delete('settings');
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** The 3D office at a task's worker's desk (`/?floor=api&worker=w-1&desk=d3`), or on its floor when no worker is known. */
export function showIn3dLink(project: string, workerId?: string, deskId?: string): string {
  const q = new URLSearchParams({ floor: project });
  const id = /^[\w-]{1,64}$/;
  if (workerId && id.test(workerId)) {
    q.set('worker', workerId);
    if (deskId && id.test(deskId)) q.set('desk', deskId);
  }
  return `/?${q.toString()}`;
}

// --- The task view --------------------------------------------------------------------------------

/** The tabs of a task's view (taskview.ts), in order. */
export type TaskTab = 'overview' | 'conversation' | 'plan' | 'runs' | 'terminal' | 'changes' | 'prs';
export const TASK_TABS: readonly TaskTab[] = ['overview', 'conversation', 'plan', 'runs', 'terminal', 'changes', 'prs'];

export function isTaskTab(v: unknown): v is TaskTab {
  return typeof v === 'string' && (TASK_TABS as readonly string[]).includes(v);
}

/**
 * The tabs a task view shows: every one on the kanban page; embedded (a task window, the 3D worker
 * window's task tab), no Terminal, since that window has the worker's terminal already; and without
 * `changes` (the worker window, whose header's 🌿 Changes opens the same view), no Changes.
 */
export function visibleTabs(embedded: boolean, changes = true): TaskTab[] {
  return TASK_TABS.filter((tab) => !(embedded && tab === 'terminal') && (changes || tab !== 'changes'));
}

/** The tab to open: the asked one when the view shows it, else Overview. */
export function tabFor(asked: unknown, embedded: boolean, changes = true): TaskTab {
  return isTaskTab(asked) && visibleTabs(embedded, changes).includes(asked) ? asked : 'overview';
}

/** One file's part of a unified diff (from its `diff --git` line to the next one). */
export interface DiffPart {
  /** The file's path after the change (before it, for a deleted file). */
  path: string;
  text: string;
}

/** The path a `diff --git a/x b/y` block is about: from its +++/--- lines, else its rename line, else the header. */
function diffPartPath(lines: string[]): string {
  for (const l of lines) if (l.startsWith('+++ b/')) return l.slice(6);
  for (const l of lines) if (l.startsWith('--- a/')) return l.slice(6);
  for (const l of lines) if (l.startsWith('rename to ')) return l.slice(10);
  const rest = lines[0]?.slice('diff --git '.length) ?? '';
  // `a/<p> b/<p>`: both halves name the same path when nothing was renamed.
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest.startsWith('a/') && rest.slice(half + 1).startsWith('b/') && rest.slice(2, half) === rest.slice(half + 3)) return rest.slice(2, half);
  const m = / b\/(.*)$/.exec(rest);
  return m ? m[1] : rest;
}

/** A unified diff cut into its files, in order (the Changes tab shows each under its file). */
export function splitDiff(diff: string): DiffPart[] {
  const parts: DiffPart[] = [];
  let cur: string[] | null = null;
  const flush = () => {
    if (cur) parts.push({ path: diffPartPath(cur), text: cur.join('\n') });
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      cur = [line];
    } else if (cur) cur.push(line);
  }
  flush();
  return parts;
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

/**
 * The task a review of the picked PRs (their refKeys) goes into: the one task every picked PR is a
 * bundle item of. PRs of different tasks, or any PR of no task the bundle knows (one of the other
 * open PRs, say), give none, and the review is a new task of its own.
 */
export function reviewTaskOf(picked: Iterable<string>, bundle: KanbanPrBundleItem[]): number | undefined {
  let taskId: number | undefined;
  for (const k of picked) {
    const id = bundle.find((b) => refKey(b) === k)?.taskId;
    if (id === undefined || (taskId !== undefined && id !== taskId)) return undefined;
    taskId = id;
  }
  return taskId;
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

// --- Links ----------------------------------------------------------------------------------------

// The office's own pages, as the server routes them (server/http/routes/pages.ts, kanban/http/routes.ts;
// tests/kanban-links.test.ts checks the two agree).
export const APP_PAGES: ReadonlySet<string> = new Set(['/', '/index.html', '/kanban', '/kanban.html', '/lite', '/lite.html', '/login', '/login.html', '/join', '/join.html', '/claim', '/claim.html']);

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The same server: same origin, or the same port on another name for this computer (an agent's 127.0.0.1 link opened as localhost). */
function sameOffice(u: URL, b: URL): boolean {
  return u.origin === b.origin || (u.protocol === b.protocol && u.port === b.port && LOOPBACK.has(u.hostname) && LOOPBACK.has(b.hostname));
}

/** The link as a URL when it leads to one of this office's own pages, else null. */
function appPageUrl(href: string, base: string): URL | null {
  try {
    const u = new URL(href, base);
    return (u.protocol === 'http:' || u.protocol === 'https:') && sameOffice(u, new URL(base)) && APP_PAGES.has(u.pathname) ? u : null;
  } catch {
    return null;
  }
}

/** Whether a link leads to one of this office's own pages, which open in the same window. */
export function isAppPage(href: string, base: string): boolean {
  return appPageUrl(href, base) !== null;
}

/** The task a link to the kanban opens (/kanban?task=12), so the kanban can show it without reloading. */
export function kanbanTaskOf(href: string, base: string): number | null {
  const u = appPageUrl(href, base);
  if (!u || (u.pathname !== '/kanban' && u.pathname !== '/kanban.html')) return null;
  const id = Number(u.searchParams.get('task'));
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** The agent that created a task on someone's behalf (an agent's create_task: the `created` event's `via`), if one did. */
export function viaAgent(events: KanbanEvent[]): string | undefined {
  const via = (events.find((e) => e.kind === 'created')?.data as { via?: unknown } | undefined)?.via;
  return typeof via === 'string' ? via : undefined;
}

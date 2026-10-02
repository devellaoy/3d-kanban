// Reading other tasks, for agents: what a reference like "14", "#14", "task 14", a ticket id or a
// bit of a title resolves to (ai-kanban's rules, so its kanban-task-refs skill reads the same), the
// bounded bundle an agent gets about one task, and the references a task's text makes to others.

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { KanbanContext } from '../../registry.js';
import type { KanbanTask, TaskRefBundle } from '../../../../shared/kanban/types.js';
import { projectRepos } from '../../projects.js';
import { clip } from '../util.js';
import { holdLine } from '../../../../shared/kanban/hold.js';

/** How big the parts of a bundle get, so one task never floods an agent's context. */
export const REF_LIMITS = {
  matches: 10,
  description: 20_000,
  plan: 20_000,
  summary: 4000,
  comments: 30,
  comment: 2000,
  runs: 30,
  runSummary: 2000,
  reportFiles: 50,
  tailLines: 200,
  tail: 20_000,
  search: 20,
} as const;

export type TaskRef = { kind: 'id'; id: number } | { kind: 'text'; text: string };

/** "14", "#14", "task 14", "tehtävä #14" are an id; anything else is text (a ticket id or part of a title). */
export function parseTaskRef(raw: string): TaskRef | undefined {
  const t = (raw ?? '').trim();
  if (!t) return undefined;
  const m = /^(?:(?:task|tehtäv\p{L}*|tiketti)\s*)?#?(\d{1,9})$/iu.exec(t);
  if (m) return { kind: 'id', id: Number(m[1]) };
  return { kind: 'text', text: t };
}

/**
 * The tasks a reference means, newest first (at most REF_LIMITS.matches). An id finds that task,
 * or else a task whose ticket is that number, never a title with the number in it; text finds the
 * task whose ticket it is exactly (any case), or else the tasks with it in their title.
 */
export function resolveTaskRef<T extends Pick<KanbanTask, 'id' | 'title' | 'ticket' | 'updatedAt'>>(raw: string, tasks: T[]): T[] {
  const ref = parseTaskRef(raw);
  if (!ref) return [];
  const needle = (ref.kind === 'id' ? String(ref.id) : ref.text).toLowerCase();
  const byTicket = () => tasks.filter((t) => (t.ticket ?? '').toLowerCase() === needle);
  let pool: T[];
  if (ref.kind === 'id') {
    const byId = tasks.filter((t) => t.id === ref.id);
    pool = byId.length ? byId : byTicket();
  } else {
    const exact = byTicket();
    pool = exact.length ? exact : tasks.filter((t) => t.title.toLowerCase().includes(needle));
  }
  return [...pool].sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id).slice(0, REF_LIMITS.matches);
}

/** A task in a list of candidates: enough to pick one. */
export function candidate(t: KanbanTask) {
  return { id: t.id, title: t.title, ...(t.ticket ? { ticket: t.ticket } : {}), status: t.status, type: t.type, project: t.project, updatedAt: t.updatedAt };
}

/** Tasks with `q` in their title, ticket or description, newest first. */
export function searchTasks(tasks: KanbanTask[], q: string, limit: number = REF_LIMITS.search): KanbanTask[] {
  const n = q.trim().toLowerCase();
  if (!n) return [];
  const score = (t: KanbanTask) => ((t.ticket ?? '').toLowerCase() === n ? 3 : t.title.toLowerCase().includes(n) ? 2 : (t.ticket ?? '').toLowerCase().includes(n) ? 1 : 0);
  return tasks
    .filter((t) => score(t) > 0 || t.description.toLowerCase().includes(n))
    .sort((a, b) => score(b) - score(a) || b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

/** Where an investigation's report files go: `<filesDir>/reports/task-<id>`. */
export function reportDir(filesDir: string, taskId: number): string {
  return path.join(filesDir, 'reports', `task-${taskId}`);
}

/** The report files under a folder (a couple of levels deep), newest first, at most `max`. */
export function reportFiles(dir: string, max: number = REF_LIMITS.reportFiles): { path: string; size: number; mtime: number }[] {
  const out: { path: string; size: number; mtime: number }[] = [];
  const walk = (d: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const p = path.join(d, name);
      try {
        const st = statSync(p);
        if (st.isDirectory()) {
          if (depth < 3) walk(p, depth + 1);
        } else if (st.isFile()) out.push({ path: p, size: st.size, mtime: st.mtimeMs });
      } catch {
        // gone meanwhile
      }
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, max);
}

/** A task, as an agent gets it: everything in bounded sizes. */
export function taskBundle(ctx: KanbanContext, t: KanbanTask): TaskRefBundle {
  const def = ctx.project(t.project);
  const branches = ctx.repo.repoBranches(t.id);
  const repos = def ? projectRepos(def).filter((r) => !t.repoIds || t.repoIds.includes(r.id) || branches[r.id]) : [];
  const plan = ctx.repo.acceptedPlan(t.id);
  const runs = ctx.repo.listRuns(t.id).slice(-REF_LIMITS.runs);
  const comments = ctx.repo
    .listComments(t.id, { limit: 200 })
    .comments.filter((c) => c.authorKind !== 'system')
    .slice(-REF_LIMITS.comments);
  return {
    id: t.id,
    title: t.title,
    description: clip(t.description, REF_LIMITS.description),
    ...(t.ticket ? { ticket: t.ticket } : {}),
    ...(t.ticketUrl ? { ticketUrl: t.ticketUrl } : {}),
    project: { id: t.project, name: def?.name ?? t.project },
    repos: repos.map((r) => {
      const branch = branches[r.id] ?? (r.primary ? t.branch : undefined) ?? t.branch;
      return { id: r.id, name: r.name, ...(branch ? { branch } : {}), ...(r.remote ? { remote: r.remote } : {}) };
    }),
    status: t.status,
    ...(t.hold ? { hold: { at: t.hold.at, ...(t.hold.note ? { note: t.hold.note } : {}), ...(t.hold.until !== undefined ? { until: t.hold.until } : {}) } } : {}),
    ...(t.phase ? { phase: t.phase } : {}),
    ...(t.summary ? { summary: clip(t.summary, REF_LIMITS.summary) } : {}),
    ...(plan ? { acceptedPlan: clip(plan.text, REF_LIMITS.plan) } : {}),
    runs: runs.map((r) => ({
      phase: r.phase,
      ...(r.round !== undefined ? { round: r.round } : {}),
      status: r.status,
      ...(r.verdict ? { verdict: r.verdict } : {}),
      ...(r.summary ? { summary: clip(r.summary, REF_LIMITS.runSummary) } : {}),
      ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}),
    })),
    comments: comments.map((c) => ({ authorKind: c.authorKind, authorName: c.authorName, kind: c.kind, text: clip(c.text, REF_LIMITS.comment), createdAt: c.createdAt })),
    prs: t.prs.map((p) => ({ ...(p.repo ? { repo: p.repo } : {}), number: p.number, url: p.url, state: p.state })),
    reportFiles: reportFiles(reportDir(ctx.filesDir, t.id)).map((f) => f.path),
  };
}

// --- References in a task's text ------------------------------------------------------------------

/**
 * `#14`, or a kanban word right before a number ("task 14", "tehtävä #14", "tehtävässä 17",
 * "tiketti 3"); a GitHub PR or issue ("PR #39", "issue #39", ".../pull/39") is skipped. Bare
 * numbers aren't references: too many of them are something else.
 */
const REF_RE = new RegExp(
  [
    // A GitHub pull request or issue: matched, so its number isn't taken for a task's.
    String.raw`(?:\b(?:pr|pull\s+requests?|issues?|gh)\b|\/(?:pull|issues)\/)[\s#]*\d+`,
    String.raw`\b(?:tasks?|tehtäv\p{L}*|tiket\p{L}*)[\s#]*(?<word>\d{1,7})`,
    String.raw`#(?<hash>\d{1,7})`,
  ]
    // Not a version number (#1.2).
    .map((p) => String.raw`(?:${p})(?!\.\d)`)
    .join('|'),
  'giu',
);
/** A Jira-style ticket id. */
const TICKET_RE = /\b[A-Z][A-Z0-9_]{1,19}-\d{1,7}\b/g;

/** The task ids a text refers to, in order. */
export function scanTaskIds(text: string): number[] {
  const out: number[] = [];
  for (const m of (text ?? '').matchAll(REF_RE)) {
    const raw = m.groups?.word ?? m.groups?.hash;
    if (!raw) continue;
    const id = Number(raw);
    if (Number.isSafeInteger(id) && id > 0 && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The ticket ids (UYT-1415) a text names, in order. */
export function scanTickets(text: string): string[] {
  return [...new Set((text ?? '').match(TICKET_RE) ?? [])];
}

/**
 * The other tasks a task's text refers to, at most `max`: numbers first, then ticket ids of other
 * tasks. Only references that mean exactly one task count (a wrong task is worse than none).
 */
export function referencedTasks(text: string, tasks: KanbanTask[], selfId: number, max = 3): KanbanTask[] {
  const self = tasks.find((t) => t.id === selfId);
  const out: KanbanTask[] = [];
  const add = (ref: string) => {
    if (out.length >= max) return;
    const m = resolveTaskRef(ref, tasks);
    if (m.length !== 1 || m[0].id === selfId || out.some((t) => t.id === m[0].id)) return;
    out.push(m[0]);
  };
  for (const id of scanTaskIds(text)) add(String(id));
  for (const ticket of scanTickets(text)) {
    if (self?.ticket && self.ticket.toLowerCase() === ticket.toLowerCase()) continue;
    // A ticket id only counts when a task has it exactly, not as a bit of a title.
    if (tasks.some((t) => (t.ticket ?? '').toLowerCase() === ticket.toLowerCase())) add(ticket);
  }
  return out;
}

/** The Markdown file a plan phase reads the referenced tasks from. */
export function referencedTasksMarkdown(bundles: TaskRefBundle[]): string {
  const cut = (s: string | undefined, n: number) => clip(s, n).trim();
  const parts = bundles.map((b) => {
    const lines = [
      `## Task #${b.id}: ${b.title}`,
      '',
      `- Project: ${b.project.name} (${b.project.id})`,
      `- Status: ${b.status === 'on_hold' ? 'On hold' : b.status}${b.phase ? `, phase ${b.phase}` : ''}`,
      ...(b.hold ? [`- ${holdLine({ ...b.hold, by: '', from: 'waiting' }, Date.now())}`] : []),
      ...(b.ticket ? [`- Ticket: ${b.ticket}${b.ticketUrl ? ` ${b.ticketUrl}` : ''}`] : []),
      ...b.repos.map((r) => `- Repository ${r.name}${r.remote ? ` (${r.remote})` : ''}${r.branch ? `: branch ${r.branch}` : ''}`),
      ...b.prs.map((p) => `- Pull request ${p.repo ? `${p.repo}#` : '#'}${p.number} (${p.state}): ${p.url}`),
      ...b.reportFiles.map((f) => `- Report file: ${f}`),
      '',
      '### Description',
      '',
      cut(b.description, 8000) || '(none)',
    ];
    if (b.acceptedPlan) lines.push('', '### Accepted plan', '', cut(b.acceptedPlan, 12_000));
    if (b.summary) lines.push('', '### Summary', '', cut(b.summary, 3000));
    const verdicts = b.runs.filter((r) => r.verdict).map((r) => `review ${r.round ?? ''}: ${r.verdict}`.replace('  ', ' '));
    if (verdicts.length) lines.push('', `Review verdicts: ${verdicts.join(', ')}`);
    const recent = b.comments.slice(-10);
    if (recent.length) {
      lines.push('', '### Latest comments (oldest first)');
      for (const c of recent) lines.push('', `**${c.authorName}** (${c.authorKind}, ${new Date(c.createdAt).toISOString().slice(0, 16).replace('T', ' ')}):`, cut(c.text, 1500));
    }
    return lines.join('\n');
  });
  return `# Referenced tasks\n\nThe task you are working on refers to these other kanban tasks. This is their real data, fetched by the office before this turn.\n\n${parts.join('\n\n---\n\n')}\n`;
}

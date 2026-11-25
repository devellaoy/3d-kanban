// A task's conversation as a file: what the user said since the task was written and the review rounds with the implementer's replies.

import type { KanbanComment, KanbanPlan, KanbanRun } from '../../shared/kanban/types.js';
import type { KanbanContext } from './registry.js';

export interface Conversation {
  /** The whole file. User messages are never cut; over `budget` chars (default 150_000) the oldest agent texts are shortened one by one to 1_500 chars, each ending "(cut here: N more characters)", and the file's head says how many entries were shortened. */
  markdown(budget?: number): string;
  /** For a prompt when the file can't be written: the newest entries that fit in `max` chars, with a first line saying how many older entries were left out (when any). */
  tail(max: number): string;
}

const KEEP = 1_500;
const PAGE = 500;
// Room for the shortening notice when the head is sized.
const NOTICE_ROOM = 120;

interface Entry {
  at: number;
  id: number;
  heading: string;
  body: string;
  agent: boolean;
}

const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

function allComments(repo: Pick<KanbanContext['repo'], 'listComments'>, taskId: number): KanbanComment[] {
  const out: KanbanComment[] = [];
  for (let before: number | undefined, more = true; more; ) {
    const page = repo.listComments(taskId, { limit: PAGE, ...(before !== undefined ? { before } : {}) });
    out.unshift(...page.comments);
    before = page.comments[0]?.id;
    more = page.more && before !== undefined;
  }
  return out;
}

/** The plan draft that waited for approval at `at`, if one did. */
function draftAt(plans: KanbanPlan[], at: number): KanbanPlan | undefined {
  let found: KanbanPlan | undefined;
  plans.forEach((p, i) => {
    const end = p.acceptedAt ?? plans[i + 1]?.createdAt ?? Infinity;
    if (at >= p.createdAt && at < end) found = p;
  });
  return found;
}

/** An agent text is only shortened when that saves more than the marker costs. */
const shortenable = (e: Entry) => e.agent && e.body.length > KEEP + 200;

/** A body is data, not the office's own words: every line is quoted, so a `## ` line inside it is never a heading. */
const quote = (text: string) => text.trim().split('\n').map((l) => (l.trim() ? `> ${l}` : '>')).join('\n');

function section(e: Entry, cut = false): string {
  if (!e.body.trim()) return `## ${e.heading}\n`;
  const marker = cut && shortenable(e) ? `\n\n(cut here: ${e.body.length - KEEP} more characters)` : '';
  return `## ${e.heading}\n\n${quote(cut && marker ? e.body.slice(0, KEEP) : e.body)}${marker}\n`;
}

export function taskConversation(ctx: Pick<KanbanContext, 'repo'>, taskId: number, userText: (c: KanbanComment) => string): Conversation | undefined {
  const comments = allComments(ctx.repo, taskId).sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  const runs = new Map<number, KanbanRun>(ctx.repo.listRuns(taskId).map((r) => [r.id, r]));
  const plans = ctx.repo.listPlans(taskId).sort((a, b) => a.version - b.version);
  const asked = new Set(comments.filter((c) => c.kind === 'questions' && c.runId !== undefined).map((c) => c.runId));
  const runOf = (c: KanbanComment) => (c.runId !== undefined ? runs.get(c.runId) : undefined);

  const picked = new Map<number, Entry>();
  const add = (c: KanbanComment, heading: string, body: string, agent: boolean) => picked.set(c.id, { at: c.createdAt, id: c.id, heading: `${stamp(c.createdAt)} — ${heading}`, body, agent });
  let cycle = 0, prevRound: number | undefined, last: { cycle: number; round?: number } | undefined;
  let found = false;
  for (const c of comments) {
    if (c.authorKind === 'user' && c.kind === 'message') {
      found = true;
      const q: string[] = [];
      const draft = draftAt(plans, c.createdAt);
      if (draft) q.push(`said while plan draft v${draft.version} waited for approval`);
      if (c.runId !== undefined && !asked.has(c.runId)) q.push("typed as an answer in the agent's terminal; the question was not recorded");
      if (c.pending) q.push('queued: the implementer has not been given this yet');
      let text = c.text;
      try {
        text = userText(c);
      } catch {
        // the attachments could not be copied: the text as written
      }
      add(c, `${c.authorName}${q.length ? ` (${q.join('; ')})` : ''}`, text, false);
    } else if (c.authorKind === 'agent' && c.kind === 'review') {
      const r = runOf(c);
      if (!r || r.phase !== 'review' || (r.seat ?? 0) > 0) continue;
      found = true;
      if (prevRound === undefined || r.round === undefined || r.round <= prevRound) cycle += 1;
      prevRound = r.round;
      last = { cycle, round: r.round };
      const verdict = r.verdict ? `: ${r.verdict === 'approved' ? 'APPROVED' : 'CHANGES_REQUESTED'}` : '';
      add(c, `Review cycle ${cycle}${r.round !== undefined ? `, round ${r.round}` : ''}${verdict}`, c.text, true);
    } else if (c.authorKind === 'agent' && c.kind === 'result') {
      const r = runOf(c);
      if (r?.phase === 'fix') add(c, last ? `Implementer's reply to review cycle ${last.cycle}${last.round !== undefined ? `, round ${last.round}` : ''}` : "Implementer's reply to a review", c.text, true);
      else if (r?.phase === 'resume') add(c, "Implementer's reply to the user's message", c.text, true);
    }
  }
  if (!found) return undefined;
  // What each user message answers: the closest agent comment before it that is not a status line.
  let prev: KanbanComment | undefined;
  for (const c of comments) {
    if (c.authorKind === 'user' && c.kind === 'message') {
      const terminal = c.runId !== undefined && !asked.has(c.runId);
      if (!terminal && prev && (prev.kind === 'questions' || prev.kind === 'result') && !picked.has(prev.id)) add(prev, `What the agent had said or asked (${prev.authorName})`, prev.text, true);
    } else if (c.authorKind === 'agent' && c.kind !== 'status') prev = c;
  }
  // Where each plan was accepted: the messages before it were known to the planner already.
  for (const p of plans) if (p.acceptedAt !== undefined) picked.set(-p.id, { at: p.acceptedAt, id: -p.id, heading: `${stamp(p.acceptedAt)} — Plan v${p.version} accepted by ${p.acceptedBy ?? 'unknown'}`, body: '', agent: false });
  const list = [...picked.values()].sort((a, b) => a.at - b.at || a.id - b.id);

  const head = `# Conversation of task #${taskId}\n\nThe user's messages since the task was written and the earlier review rounds with the implementer's replies, oldest first.\nThe office keeps this data and rewrites the file before each review round.\nHeadings (\`## \`) are written by the office; everything quoted (\`> \`) under one is the author's own text.\nA message dated before a plan's acceptance was already known when that plan was accepted.\n`;
  return {
    markdown(budget = 150_000) {
      const cut = new Set<Entry>();
      let size = head.length + list.reduce((n, e) => n + section(e).length + 1, 0);
      for (const e of list) {
        if (size <= budget) break;
        if (!shortenable(e)) continue;
        size -= section(e).length - section(e, true).length;
        cut.add(e);
        if (cut.size === 1) size += NOTICE_ROOM;
      }
      const notice = cut.size ? `\n${cut.size} older agent ${cut.size === 1 ? 'entry is' : 'entries are'} shortened in this file; each says where it is cut.\n` : '';
      return `${head}${notice}\n${list.map((e) => section(e, cut.has(e))).join('\n')}`;
    },
    tail(max) {
      const parts: string[] = [];
      let used = 0, i = list.length;
      while (i > 0) {
        let s = section(list[i - 1]);
        if (used + s.length + 1 > max - NOTICE_ROOM) {
          // The newest entry alone may not fit: its start is kept.
          if (parts.length) break;
          const room = Math.max(0, max - NOTICE_ROOM - 1);
          let n = Math.max(0, room - list[i - 1].heading.length - 60);
          do {
            s = `${section({ ...list[i - 1], body: list[i - 1].body.slice(0, n) })}\n(cut here)\n`;
            n = Math.floor(n * 0.8);
          } while (s.length > room && n > 0);
        }
        parts.unshift(s);
        used += s.length + 1;
        i -= 1;
      }
      const left = list.length - parts.length;
      return `${left ? `(${left} older ${left === 1 ? 'entry' : 'entries'} left out)\n\n` : ''}${parts.join('\n')}`;
    },
  };
}

// A task's comments and files as the task view (taskview.ts) shows them. Files a text already shows
// (their links, put in where the cursor was: attachbox.ts) aren't listed again; older comments, whose
// files went in a list of their own, still list them below the text. An agent's comment is coloured by
// who wrote it, the implementer or the reviewer (its run's role), and its file paths can be links.

import { h, timeAgo } from '../ui/dom';
import type { CommentKind, KanbanAttachment, KanbanComment, KanbanRole, KanbanRun } from '../../shared/kanban/types.js';
import { attachmentUrl, formatSize, isImage, notInText } from './attach';
import { TOOL_ICON } from './card';
import { fmtTime } from './labels';
import { renderMarkdown } from './md';
import type { OpenFile } from './mdlinks';

const COMMENT_KIND_NAMES: Record<CommentKind, string> = { message: 'message', result: 'result', plan: 'plan', questions: 'questions', review: 'review', status: 'status' };

export function attachmentList(files: KanbanAttachment[]): HTMLElement {
  return h(
    'ul.kb-files',
    {},
    ...files.map((a) =>
      h(
        'li',
        {},
        isImage(a.mime) ? h('a.kb-thumb', { href: attachmentUrl(a.id), target: '_blank', rel: 'noopener noreferrer' }, h('img', { src: attachmentUrl(a.id), alt: a.name, loading: 'lazy' })) : null,
        h('a', { href: attachmentUrl(a.id), target: '_blank', rel: 'noopener noreferrer' }, `📄 ${a.name}`),
        h('small.kb-muted', {}, formatSize(a.size)),
      ),
    ),
  );
}

const ROLE_NAMES: Record<KanbanRole, string> = { implementer: 'implementer', reviewer: 'reviewer' };

/** Who wrote an agent's comment: its run's role, else (a comment from before runs were kept) its author's "(reviewer)". */
export function commentRole(c: Pick<KanbanComment, 'authorKind' | 'authorName' | 'runId'>, runs: Map<number, Pick<KanbanRun, 'role'>>): KanbanRole | undefined {
  if (c.authorKind !== 'agent') return undefined;
  return (c.runId !== undefined ? runs.get(c.runId)?.role : undefined) ?? (/\(reviewer\)$/.test(c.authorName) ? 'reviewer' : 'implementer');
}

export interface CommentOpts {
  /** The task's runs by id, for the role of an agent's comment. */
  runs?: Map<number, Pick<KanbanRun, 'role'>>;
  /** Opens a file the text names (admins: kanban.task.openFile); without it paths stay text. */
  openFile?: OpenFile;
}

export function commentItem(c: KanbanComment, files: Map<string, KanbanAttachment>, openTask: (id: number) => void, opts: CommentOpts = {}): HTMLElement {
  const role = commentRole(c, opts.runs ?? new Map());
  const who = c.authorKind === 'agent' ? `${c.tool ? `${TOOL_ICON[c.tool]} ` : '🤖 '}${c.authorName}` : c.authorKind === 'system' ? `⚙️ ${c.authorName}` : `👤 ${c.authorName}`;
  const attached = notInText(c.attachmentIds.map((id) => files.get(id)).filter((a): a is KanbanAttachment => !!a), c.text);
  return h(
    'li.kb-comment',
    { class: `${c.authorKind} ${c.kind}${role ? ` ${role}` : ''}${c.pending ? ' pending' : ''}` },
    h(
      'header',
      {},
      h('b', {}, who),
      role ? h('span.kb-role', { class: role }, ROLE_NAMES[role]) : null,
      c.kind !== 'message' ? h('span.kb-kind', { class: c.kind }, COMMENT_KIND_NAMES[c.kind]) : null,
      c.pending ? h('span.kb-kind.pending', { title: 'Written while the agent was busy: it gets it at its next pause' }, 'waiting') : null,
      h('time', { datetime: new Date(c.createdAt).toISOString(), title: fmtTime(c.createdAt) }, timeAgo(c.createdAt)),
    ),
    // System lines are short and many: plain text keeps them quiet.
    c.authorKind === 'system' && c.kind === 'status' ? h('p', {}, c.text) : renderMarkdown(c.text, openTask, '', opts.openFile),
    attached.length ? attachmentList(attached) : null,
  );
}

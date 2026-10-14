// A task's comments and files as the task view (taskview.ts) shows them. Files a text already shows
// (their links, put in where the cursor was: attachbox.ts) aren't listed again; older comments, whose
// files went in a list of their own, still list them below the text.

import { h, timeAgo } from '../ui/dom';
import type { CommentKind, KanbanAttachment, KanbanComment } from '../../shared/kanban/types.js';
import { attachmentUrl, formatSize, isImage, notInText } from './attach';
import { TOOL_ICON } from './card';
import { fmtTime } from './labels';
import { renderMarkdown } from './md';

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

export function commentItem(c: KanbanComment, files: Map<string, KanbanAttachment>, openTask: (id: number) => void): HTMLElement {
  const who = c.authorKind === 'agent' ? `${c.tool ? `${TOOL_ICON[c.tool]} ` : '🤖 '}${c.authorName}` : c.authorKind === 'system' ? `⚙️ ${c.authorName}` : `👤 ${c.authorName}`;
  const attached = notInText(c.attachmentIds.map((id) => files.get(id)).filter((a): a is KanbanAttachment => !!a), c.text);
  return h(
    'li.kb-comment',
    { class: `${c.authorKind} ${c.kind}${c.pending ? ' pending' : ''}` },
    h(
      'header',
      {},
      h('b', {}, who),
      c.kind !== 'message' ? h('span.kb-kind', { class: c.kind }, COMMENT_KIND_NAMES[c.kind]) : null,
      c.pending ? h('span.kb-kind.pending', { title: 'Written while the agent was busy: it gets it at its next pause' }, 'waiting') : null,
      h('time', { datetime: new Date(c.createdAt).toISOString(), title: fmtTime(c.createdAt) }, timeAgo(c.createdAt)),
    ),
    // System lines are short and many: plain text keeps them quiet.
    c.authorKind === 'system' && c.kind === 'status' ? h('p', {}, c.text) : renderMarkdown(c.text, openTask, ''),
    attached.length ? attachmentList(attached) : null,
  );
}

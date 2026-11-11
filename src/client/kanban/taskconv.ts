// The task view's Conversation tab: the comment box at the top, the comments newest first, and older
// pages on demand (taskview.ts).

import { h, toast } from '../ui/dom';
import { btn } from '../ui/kit';
import { store } from '../state';
import type { KanbanServerMsg } from '../../shared/kanban/protocol.js';
import type { KanbanTask } from '../../shared/kanban/types.js';
import { attachBox, type AttachBox } from './attachbox';
import { commentItem } from './commentview';
import { kstore } from './store';
import { onSendKey, sendHint } from './sendkey';
import { textArea } from './ui';
import type { Detail, TaskCtx } from './taskctx';

export const COMMENTS_PAGE = 30;

export class Conversation {
  private composer: { el: HTMLElement; ta: HTMLTextAreaElement; attach: AttachBox } | null = null;
  private loadingOlder = false;

  constructor(private c: TaskCtx) {}

  private makeComposer(task: KanbanTask) {
    const ta = textArea('', { rows: 3, placeholder: 'Write a comment, answer, or tell the agent what to do next… (paste or drop files)', 'aria-label': 'Comment', 'data-focus': 'comment' });
    const send = btn('Send', { icon: 'send', size: 'sm', attrs: { 'data-focus': 'act-comment' } });
    const hint = h('span.composite-note', {}, `${sendHint()} · ${task.status === 'todo' || task.status === 'done' ? 'a comment is kept with the task' : task.status === 'on_hold' ? 'a comment is kept and given to the agent when it resumes' : 'a comment puts the agent back to work'}`);
    const wrap = h('div.kb-composer.composite');
    const attach = attachBox({ target: ta, dropZone: wrap, insertLinks: true });
    const go = async () => {
      const text = ta.value.trim();
      const ids = attach.ids();
      if (!text) return ta.focus();
      if (attach.busy()) return toast('Wait for the files to finish uploading', 'warn');
      const ok = await this.c.req({ t: 'kanban.comment.add', id: task.id, text, ...(ids.length ? { attachmentIds: ids } : {}) }, send);
      if (ok) {
        ta.value = '';
        attach.clear();
      }
    };
    send.addEventListener('click', () => void go());
    onSendKey(ta, () => void go());
    wrap.append(ta, h('div.composite-bar', {}, attach.el, hint, send));
    return { el: wrap, ta, attach };
  }

  pane(d: Detail): HTMLElement[] {
    this.composer ??= this.makeComposer(d.task);
    const byId = new Map(d.attachments.map((a) => [a.id, a]));
    const list = h('ol.kb-comments', { 'aria-label': 'Conversation' });
    const runs = new Map(d.runs.map((r) => [r.id, r]));
    const openFile = kstore.me.admin || store.me.admin ? (path: string, line?: number) => void this.c.req({ t: 'kanban.task.openFile', id: d.task.id, path, ...(line ? { line } : {}) }, undefined, 'Opening in VS Code…') : undefined;
    for (const comment of [...d.comments].reverse()) list.append(commentItem(comment, byId, (id) => this.c.openTask(id), { runs, openFile }));
    if (!d.comments.length) list.append(h('li.kb-muted', {}, 'No comments yet.'));
    const more = d.commentsMore
      ? btn(this.loadingOlder ? 'Loading…' : 'Older comments', { size: 'sm', attrs: { class: 'kb-older', disabled: this.loadingOlder, 'data-focus': 'older', onclick: () => void this.older() } })
      : null;
    return [this.composer.el, list, ...(more ? [more] : [])];
  }

  private async older() {
    const d = this.c.detail;
    if (!d || this.loadingOlder) return;
    this.loadingOlder = true;
    this.c.paint();
    try {
      const r = await this.c.api.request<Extract<KanbanServerMsg, { t: 'kanban.comments' }>>({ t: 'kanban.comments.page', id: d.task.id, before: d.comments[0]?.id, limit: COMMENTS_PAGE });
      if (this.c.detail === d) {
        const have = new Set(d.comments.map((x) => x.id));
        d.comments = [...r.comments.filter((x) => !have.has(x.id)), ...d.comments].sort((a, b) => a.id - b.id);
        d.commentsMore = r.more;
      }
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      this.loadingOlder = false;
      if (this.c.alive()) this.c.paint();
    }
  }
}

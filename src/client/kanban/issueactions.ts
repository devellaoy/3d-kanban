// The actions on one issue of an issue source (docs/kanban-architecture.md §6), in one panel shared by
// the kanban's issue window and the 3D office's issue cards: move its status, (un)assign it, read and
// add its comments. Everything is inline (no window of its own), so Esc and ✕ close the window it is in.
// The office does the writes and sends the fresh list out again; update() only repaints from that.

import './issueactions.css';
import { h, timeAgo } from '../ui/dom';
import type { KanbanServerMsg } from '../../shared/kanban/protocol.js';
import type { IssueCommentItem, IssuePerson } from '../../shared/kanban/issueops.js';
import type { KanbanApi } from './api';
import { renderMarkdown } from './md';
import { onSendKey, sendHint } from './sendkey';
import { run, textArea, textInput } from './ui';
import { groupTransitions, isGithubKey, jiraSite, pinnedMe, setPinnedMe, transitionLabel } from './issueactionsmodel';

type Transitions = Extract<KanbanServerMsg, { t: 'kanban.issueTransitions' }>;
type Comments = Extract<KanbanServerMsg, { t: 'kanban.issueComments' }>;
type People = Extract<KanbanServerMsg, { t: 'kanban.issuePeople' }>;

/** What the panel needs to know of the issue: from the kanban's list, or a 3D card. */
export interface ActionIssue {
  key: string;
  url?: string;
  status?: string;
  assignee?: string;
}

export type IssueSection = 'status' | 'assignee' | 'comments';

export interface IssueActionsOpts {
  sections?: readonly IssueSection[];
  /** Where a #123 in a comment goes. */
  openTask?: (id: number) => void;
}

export function issueActions(api: KanbanApi, project: string, first: ActionIssue, opts: IssueActionsOpts = {}): { el: HTMLElement; update(issue: ActionIssue): void } {
  let issue = first;
  const sections = opts.sections ?? ['status', 'assignee', 'comments'];
  const openTask = opts.openTask ?? ((id: number) => location.assign(`/kanban?task=${id}`));
  const base = { project, issueKey: issue.key };
  const github = isGithubKey(issue.key);
  const el = h('div.kb-ia', { role: 'group', 'aria-label': `Actions on ${issue.key}` });
  const errorLine = (msg: string, retry: () => void) => {
    const again = h('button.btn.small', { type: 'button' }, 'Try again');
    again.addEventListener('click', retry);
    return h('p.kb-ia-error', { role: 'alert' }, `⚠️ ${msg} `, again);
  };
  const painters: (() => void)[] = [];

  // ---- Status ----
  if (sections.includes('status')) {
    const now = h('span.kb-ia-now');
    const box = h('div.kb-ia-body');
    const reload = h('button.btn.small.kb-ia-icon', { type: 'button', title: 'Load the choices again', 'aria-label': 'Load the status choices again' }, '↻') as HTMLButtonElement;
    let answer: Transitions | null = null;
    let gen = 0;
    const paintNow = () => (now.textContent = issue.status ?? answer?.current ?? '—');
    const load = () => {
      const g = ++gen;
      box.replaceChildren(h('p.kb-ia-quiet', {}, 'Loading the choices…'));
      reload.disabled = true;
      api
        .request<Transitions>({ t: 'kanban.issue.transitions', ...base })
        .then((a) => {
          if (g !== gen) return;
          answer = a;
          paintNow();
          paintChoices();
        })
        .catch((err: Error) => g === gen && box.replaceChildren(errorLine(err.message, load)))
        .finally(() => g === gen && (reload.disabled = false));
    };
    const paintChoices = () => {
      const a = answer!;
      if (a.cannot) return box.replaceChildren(h('p.kb-ia-quiet', {}, a.cannot));
      const ts = a.transitions;
      const parts: Node[] = [];
      if (!ts.length) parts.push(h('p.kb-ia-quiet', {}, 'Nowhere to move it from here.'));
      else {
        const sel = h('select.kb-ia-select', { 'aria-label': `Move ${issue.key} to` }) as HTMLSelectElement;
        sel.append(h('option', { value: '' }, 'Move to…'));
        for (const [group, items] of groupTransitions(ts)) {
          const opts = items.map((t) => h('option', { value: t.id, disabled: !!t.needs?.length || !!t.current }, transitionLabel(t)));
          if (group) sel.append(h('optgroup', { label: group }, ...opts));
          else sel.append(...opts);
        }
        sel.addEventListener('change', async () => {
          const t = ts.find((x) => x.id === sel.value);
          if (!t) return;
          sel.disabled = true;
          const ok = await run(() => api.request({ t: 'kanban.issue.transition', ...base, transitionId: t.id }), null, `${issue.key} → ${t.to || t.name}`);
          sel.disabled = false;
          if (ok) load();
          else sel.value = '';
        });
        parts.push(sel);
        const needs = ts.filter((t) => t.needs?.length);
        if (needs.length && issue.url)
          parts.push(h('p.kb-ia-quiet', {}, `${needs.map((t) => t.name).join(', ')} need${needs.length === 1 ? 's' : ''} more fields: `, h('a', { href: issue.url, target: '_blank', rel: 'noopener noreferrer' }, 'do it in Jira ↗')));
      }
      if (a.note) parts.push(h('p.kb-ia-note', {}, `⚠️ ${a.note}`));
      box.replaceChildren(...parts);
    };
    reload.addEventListener('click', load);
    painters.push(paintNow);
    el.append(h('section.kb-ia-sec', {}, h('div.kb-ia-head', {}, h('h4', {}, 'Status'), now, reload), box));
    paintNow();
    load();
  }

  // ---- Assignee ----
  if (sections.includes('assignee')) {
    const site = github ? '' : jiraSite(issue.url);
    const who = h('span.kb-ia-now');
    const mine = h('button.btn.small', { type: 'button' }, '🙋 Assign to me') as HTMLButtonElement;
    const other = h('button.btn.small', { type: 'button', 'aria-expanded': 'false' }, 'Someone else…') as HTMLButtonElement;
    const none = h('button.btn.small', { type: 'button' }, 'Unassign') as HTMLButtonElement;
    const search = textInput('', { type: 'search', placeholder: 'Search people', 'aria-label': 'Search people to assign' });
    const hint = h('p.kb-ia-quiet');
    const results = h('ul.kb-ia-people', { 'aria-live': 'polite' });
    const picker = h('div.kb-ia-picker', { hidden: true }, search, hint, results);
    let gen = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let found: { items: IssuePerson[]; query: string } | null = null;
    const paintPeople = () => found && results.replaceChildren(...(found.items.length ? found.items.map(person) : [h('li.kb-ia-quiet', {}, found.query ? 'Nobody matches' : 'Type a name')]));
    const paintWho = () => {
      who.textContent = issue.assignee ? `👤 ${issue.assignee}` : 'Unassigned';
      const me = site ? pinnedMe(site) : undefined;
      mine.title = github ? 'Assign it to your own GitHub sign-in' : me ? `Assign it to ${me.name} (pinned as you on ${site})` : `Pin yourself first: 📌 on your name in the search`;
      none.disabled = !issue.assignee;
    };
    const assign = (to: { me: true } | { id: string } | null, button: HTMLButtonElement | null, label: string) =>
      run(() => api.request({ t: 'kanban.issue.assign', ...base, to }), button, label).then((ok) => {
        if (ok) showPicker(false);
      });
    const person = (p: IssuePerson) => {
      const pick = h('button.kb-ia-person', { type: 'button', title: `Assign ${issue.key} to ${p.name}` }, h('b', {}, p.name), p.login && p.login !== p.name ? h('small', {}, p.login) : null) as HTMLButtonElement;
      pick.addEventListener('click', () => void assign({ id: p.id }, pick, `${issue.key} → ${p.name}`));
      if (!site) return h('li', {}, pick);
      const pinned = pinnedMe(site)?.id === p.id;
      const pin = h('button.btn.small.kb-ia-pin', { type: 'button', 'aria-pressed': String(pinned), title: pinned ? `You are pinned as ${p.name} on ${site}: click to unpin` : `This is me (on ${site}): makes 🙋 Assign to me work` }, pinned ? '📌 Me' : '📌 This is me');
      pin.addEventListener('click', () => {
        setPinnedMe(site, pinned ? undefined : p);
        hint.textContent = pinned ? '' : `📌 This browser knows you as ${p.name} on ${site}: 🙋 Assign to me works now.`;
        hint.hidden = pinned;
        paintWho();
        paintPeople();
      });
      return h('li', {}, pick, pin);
    };
    const find = () => {
      const g = ++gen;
      const query = search.value.trim();
      results.replaceChildren(h('li.kb-ia-quiet', {}, 'Searching…'));
      return api
        .request<People>({ t: 'kanban.issue.people', ...base, ...(query ? { query } : {}) })
        .then((a) => {
          if (g !== gen) return;
          if (a.cannot) return results.replaceChildren(h('li.kb-ia-quiet', {}, a.cannot));
          found = { items: a.items, query };
          paintPeople();
        })
        .catch((err: Error) => g === gen && results.replaceChildren(h('li', {}, errorLine(err.message, () => void find()))));
    };
    const showPicker = (on: boolean, why = '') => {
      picker.hidden = !on;
      other.setAttribute('aria-expanded', String(on));
      hint.textContent = why;
      hint.hidden = !why;
      if (!on) return;
      search.focus();
      void find();
    };
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => void find(), 300);
    });
    mine.addEventListener('click', () => {
      if (github) return void assign({ me: true }, mine, `${issue.key} is yours`);
      const me = site ? pinnedMe(site) : undefined;
      if (me) return void assign({ id: me.id }, mine, `${issue.key} is yours`);
      showPicker(true, `Find yourself and press 📌 This is me once: this browser then knows you on ${site || 'this Jira site'}.`);
    });
    other.addEventListener('click', () => showPicker(!!picker.hidden));
    none.addEventListener('click', () => void assign(null, none, `${issue.key} is unassigned`));
    painters.push(paintWho);
    el.append(h('section.kb-ia-sec', {}, h('div.kb-ia-head', {}, h('h4', {}, 'Assignee'), who), h('div.kb-ia-body', {}, h('div.kb-ia-row', {}, mine, other, none), picker)));
    paintWho();
  }

  // ---- Comments ----
  if (sections.includes('comments')) {
    const list = h('ol.kb-ia-comments', { 'aria-label': 'Comments' });
    const ta = textArea('', { rows: 3, placeholder: `Comment on ${issue.key} · ${sendHint()}`, 'aria-label': `Comment on ${issue.key}` });
    const send = h('button.btn.small.primary', { type: 'button' }, 'Comment') as HTMLButtonElement;
    const composer = h('div.kb-ia-composer', {}, ta, h('div.kb-ia-row', {}, h('small.kb-ia-quiet.grow', {}, sendHint()), send));
    let gen = 0;
    const comment = (c: IssueCommentItem) =>
      h(
        'li.kb-ia-comment',
        {},
        h('header', {}, h('b', {}, c.author || 'someone'), h('time', { datetime: c.createdAt, title: new Date(c.createdAt).toLocaleString() }, timeAgo(c.createdAt)), c.url ? h('a', { href: c.url, target: '_blank', rel: 'noopener noreferrer', title: 'Open it at the source' }, '↗') : null),
        renderMarkdown(c.body, openTask, '(empty)'),
      );
    const load = () => {
      const g = ++gen;
      list.replaceChildren(h('li.kb-ia-quiet', {}, 'Loading comments…'));
      api
        .request<Comments>({ t: 'kanban.issue.comments', ...base })
        .then((a) => {
          if (g !== gen) return;
          composer.hidden = !!a.cannot;
          if (a.cannot) return list.replaceChildren(h('li.kb-ia-quiet', {}, a.cannot));
          list.replaceChildren(...(a.items.length ? a.items.map(comment) : [h('li.kb-ia-quiet', {}, 'No comments yet.')]));
        })
        .catch((err: Error) => g === gen && list.replaceChildren(h('li', {}, errorLine(err.message, load))));
    };
    const post = async () => {
      const text = ta.value.trim();
      if (!text) return ta.focus();
      ta.disabled = true;
      const ok = await run(() => api.request({ t: 'kanban.issue.comment', ...base, text }), send, 'Comment added');
      ta.disabled = false;
      if (!ok) return ta.focus();
      ta.value = '';
      load();
    };
    onSendKey(ta, () => void post());
    send.addEventListener('click', () => void post());
    el.append(h('section.kb-ia-sec', {}, h('div.kb-ia-head', {}, h('h4', {}, 'Comments')), h('div.kb-ia-body', {}, list, composer)));
    load();
  }

  return {
    el,
    update(next) {
      issue = { ...next, key: issue.key };
      for (const p of painters) p();
    },
  };
}

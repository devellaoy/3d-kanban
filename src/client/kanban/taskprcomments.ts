// The review comments on the task view's Pull requests tab, under the table of pull requests (taskprs.ts): the list the
// implementer made of the open PRs' unresolved comments with its analysis of each (what it means, whether it is valid,
// whether this task caused it, whether it is worth fixing), a decision per comment (Fix, Don't fix or Custom, with a
// text box) and Send to the implementer. The list comes over REST and is read again when the task moves on, like the
// reports (taskreports.ts); the decisions being filled in are kept outside the view (prcommentsmodel.ts), and the section
// is built once per fetched state, so a redraw of the tab puts the same boxes back. Every text of the agent and of the
// host is drawn as plain text.

import './taskprcomments.css';
import { h, timeAgo } from '../ui/dom';
import { icon } from '../ui/icons';
import { btn, segmented } from '../ui/kit';
import type { KanbanTask } from '../../shared/kanban/types.js';
import { PR_ANSWER_TEXT_MAX, type PrCommentAnswer, type PrCommentDecision, type PrCommentItem, type PrCommentsState } from '../../shared/kanban/prcomments.js';
import { canFixPrs } from '../../shared/kanban/prs.js';
import { apiUrl } from '../multiplayer/visit';
import { getJson } from './api';
import { fmtTime } from './labels';
import { CAUSED_MARK, DECISION_LABEL, DraftStore, KIND_LABEL, RECOMMEND_MARK, VALID_MARK, answeredCount, countText, draftAnswers, droppedText, groupByPr, placeText, safeHref, sendState, textHint, viewOf, type Drafts, type Mark, type PrGroup } from './prcommentsmodel';
import type { TaskCtx } from './taskctx';
import { textArea } from './ui';

/** The decisions being filled in, kept across redraws and across windows opened again. */
const drafts = new DraftStore();

const DECISIONS: readonly (readonly [PrCommentDecision, string])[] = [
  ['fix', DECISION_LABEL.fix],
  ['skip', DECISION_LABEL.skip],
  ['custom', DECISION_LABEL.custom],
];

const mark = (m: Mark) => h('span.st-pill.kb-prc-mark', { class: m.tone }, m.text);

/** One row of the analysis: its label, a mark and the reason. */
function row(label: string, m: Mark | null, why: string): HTMLElement {
  return h('div.kb-prc-row', {}, h('dt', {}, label), h('dd', {}, m ? mark(m) : null, why ? h('span.kb-prc-why', {}, why) : null));
}

export class PrComments {
  private state: PrCommentsState | null = null;
  private key = '';
  private seq = 0;
  /** The section as it was last built, and what it was built from: a redraw with the same state gets the same elements. */
  private built: { state: PrCommentsState; gate: string; el: HTMLElement } | null = null;

  constructor(private c: TaskCtx) {}

  /** Reads the list again when the task moved on (a fetch started or ended, the answers went). */
  follow(key: string) {
    if (this.key === key) return;
    this.key = key;
    void this.load();
  }

  private async load() {
    const n = ++this.seq;
    let state: PrCommentsState | null = null;
    try {
      state = await getJson<PrCommentsState>(apiUrl(`/api/kanban/tasks/${this.c.taskId}/pr-comments`));
    } catch {
      // Nothing to show (or an office without the plugin): the section stays away.
    }
    if (!this.c.alive() || n !== this.seq) return;
    this.state = state;
    this.c.paint('prs');
  }

  /** The section under the PRs table, or null when no list was ever fetched. `repoName`: a link's repository as the table shows it. */
  section(task: KanbanTask, repoName: (p: Pick<KanbanTask['prs'][number], 'repo' | 'repoId'>) => string): HTMLElement | null {
    const s = this.state;
    const v = viewOf(s);
    if (!s || v.kind === 'none') return null;
    const can = canFixPrs(task);
    const gate = `${can.ok}:${can.ok ? '' : can.reason}:${task.prs.map((p) => `${p.url}#${p.number}:${repoName(p)}`).join('|')}`;
    if (this.built && this.built.state === s && this.built.gate === gate) return this.built.el;
    const el = h('section.kb-sec.kb-prc', {}, h('div.kb-sec-head', {}, h('h4', {}, 'Review comments'), s.fetchedAt && s.status !== 'running' ? h('small.kb-muted', { title: fmtTime(s.fetchedAt) }, `Fetched ${timeAgo(s.fetchedAt)}`) : null));
    if (v.kind === 'line') el.append(h('p.kb-muted.kb-prc-line', {}, v.text));
    else if (v.kind === 'failed') el.append(this.failed(v.error, can));
    else el.append(...this.list(s, groupByPr(s.items, task.prs, repoName), can));
    if (s.dropped > 0 && s.status !== 'running') el.append(h('p.kb-muted.kb-prc-line', {}, droppedText(s.dropped)));
    this.built = { state: s, gate, el };
    return el;
  }

  private fetch(b: HTMLButtonElement) {
    void this.c.req({ t: 'kanban.pr.comments.fetch', taskId: this.c.taskId }, b, 'The implementer reads the review comments').then((ok) => ok && this.load());
  }

  private failed(error: string, can: ReturnType<typeof canFixPrs>): HTMLElement {
    const again = btn('Retry', { icon: 'rotate-cw', size: 'sm', attrs: { disabled: !can.ok, title: can.ok ? 'Have the implementer fetch the review comments again' : can.reason, 'data-focus': 'prc-retry' } });
    again.addEventListener('click', () => this.fetch(again));
    return h('div.kb-error.kb-row', { role: 'alert' }, icon('triangle-alert'), h('span.grow.kb-prc-error', {}, error), again);
  }

  private list(s: PrCommentsState, groups: PrGroup[], can: ReturnType<typeof canFixPrs>): HTMLElement[] {
    const sent = s.sent;
    const fetchedAt = s.fetchedAt ?? 0;
    const mine = drafts.of(this.c.taskId, fetchedAt);
    const count = h('span.kb-muted', { 'aria-live': 'polite' });
    const send = btn('Send to the implementer', { kind: 'primary', icon: 'send', attrs: { 'data-focus': 'prc-send' } });
    const sync = () => {
      count.textContent = countText(answeredCount(s.items, mine), s.items.length);
      const st = sendState(s.items, mine, can);
      send.disabled = !st.enabled;
      send.title = st.title;
    };
    send.addEventListener('click', async () => {
      const ok = await this.c.req({ t: 'kanban.pr.comments.send', taskId: this.c.taskId, fetchedAt, answers: draftAnswers(s.items, mine) }, send, 'Sent to the implementer');
      if (!ok) return sync(); // the request put the button back on: off again when the answers are not complete
      drafts.clear(this.c.taskId);
      void this.load();
    });
    const out = groups.map((g) => {
      const href = safeHref(g.pr);
      const name = g.number !== undefined ? `#${g.number}` : g.pr;
      const link = href ? h('a.kb-pr-link', { href, target: '_blank', rel: 'noopener noreferrer' }, name, icon('external-link', { size: 12 })) : h('span', {}, name);
      return h(
        'div.kb-prc-group',
        {},
        h('div.kb-prc-pr', {}, icon('git-pull-request', { size: 14 }), g.repo ? h('b', {}, g.repo) : null, link, h('small.kb-muted', {}, `${g.items.length} ${g.items.length === 1 ? 'comment' : 'comments'}`)),
        h('ul.kb-prc-items', {}, ...g.items.map((i) => this.item(i, sent ? { answer: sent.answers.find((a) => a.id === i.id) } : { drafts: mine, sync })),
        ),
      );
    });
    if (sent) out.push(h('div.kb-prc-foot', {}, h('span.kb-locked', { title: fmtTime(sent.at) }, icon('lock', { size: 12 }), `Sent ${timeAgo(sent.at)}`)));
    else {
      sync();
      out.push(h('div.kb-prc-foot', {}, count, send));
    }
    return out;
  }

  /** One comment: who and where, its text, the analysis, and the decision (to fill in, or as it was sent). */
  private item(i: PrCommentItem, mode: { answer: PrCommentAnswer | undefined } | { drafts: Drafts; sync: () => void }): HTMLElement {
    const href = safeHref(i.url);
    const place = placeText(i);
    const el = h(
      'li.kb-prc-item',
      {},
      h(
        'header.kb-prc-head',
        {},
        h('span.kb-who', {}, icon('user', { size: 14 }), h('b', {}, i.author)),
        i.authorAssociation ? h('small.kb-muted', {}, i.authorAssociation.toLowerCase()) : null,
        h('span.kb-kind', {}, KIND_LABEL[i.kind]),
        href ? h('a.kb-prc-place', { href, target: '_blank', rel: 'noopener noreferrer', title: 'Open the comment on the host' }, i.path ? h('code', {}, place) : place, icon('external-link', { size: 12 })) : h('span.kb-prc-place', {}, i.path ? h('code', {}, place) : place),
      ),
      h('blockquote.kb-prc-body', {}, i.body),
      h(
        'dl.kb-prc-rows',
        {},
        row('What it means', null, i.meaning),
        row('Valid', VALID_MARK[i.valid], i.validWhy),
        row('Caused by this task', CAUSED_MARK[i.causedByTask], i.causedWhy),
        row('Worth fixing', RECOMMEND_MARK[i.recommend], i.recommendWhy),
      ),
    );
    if ('answer' in mode) {
      const a = mode.answer;
      el.classList.add('locked');
      el.append(h('div.kb-prc-answer', {}, h('span.kb-prc-answer-label', {}, 'Your decision'), h('span.st-pill.kb-prc-mark.neutral', {}, a ? DECISION_LABEL[a.decision] : 'None'), a?.text ? h('p.kb-prc-answer-text', {}, a.text) : null));
      return el;
    }
    const { drafts: mine, sync } = mode;
    const draft = mine.get(i.id) ?? {};
    const put = (patch: typeof draft) => mine.set(i.id, { ...mine.get(i.id), ...patch });
    const ta = textArea(draft.text ?? '', { class: 'inp', rows: 2, maxlength: PR_ANSWER_TEXT_MAX, placeholder: textHint(draft.decision), 'aria-label': `Your text for the comment by ${i.author} at ${place}`, 'data-focus': `prc-text-${i.id}` });
    ta.addEventListener('input', () => {
      put({ text: ta.value });
      sync();
    });
    // Nothing is picked until the user picks: the agent's suggestion is shown above, the decision is theirs.
    const seg = segmented<PrCommentDecision>(
      DECISIONS,
      (draft.decision ?? '') as PrCommentDecision,
      (decision) => {
        put({ decision });
        ta.placeholder = textHint(decision);
        ta.required = decision === 'custom';
        sync();
      },
      `Decision for the comment by ${i.author} at ${place}`,
    );
    for (const [v, b] of seg.buttons) b.dataset.focus = `prc-${v}-${i.id}`;
    ta.required = draft.decision === 'custom';
    el.append(h('div.kb-prc-choice', {}, seg.el, ta));
    return el;
  }
}
